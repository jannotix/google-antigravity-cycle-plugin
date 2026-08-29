import { release } from "../admission.ts"
import { issueCaptureCapabilities, redeemCaptureCapability } from "../store/capabilities.ts"
import { ROLES, type Configuration } from "../config.ts"
import { resolveRole } from "../roles.ts"
import { advanceGoalOfWorkflow, linkStartedWorkflow } from "../goals.ts"
import { captureBlocked, captureDelivery, recall } from "../memory.ts"
import { parseSnapshot } from "../evidence/accessibility.ts"
import type { CapturedCandidate } from "../evidence/candidate.ts"
import {
  commitMessage,
  DeliveryAborted,
  deliveryOf,
  promote,
  recoverDelivery,
} from "../evidence/delivery.ts"
import { browserEvidence, type CapturedBy } from "../evidence/browser.ts"
import type { VerificationOutcome } from "../evidence/gates.ts"
import { proofEvidence, proofGateName } from "../evidence/proof-evidence.ts"
import { runProof, type ProofRequest } from "../evidence/proof.ts"
import { loadEvidence, recordEvidence } from "../store/evidence.ts"
import { latestCheckpoint, signCheckpoint, verifyCheckpoints } from "../store/checkpoints.ts"
import { appendHistory, lastEvent, readHistory, verifyHistory } from "../store/history.ts"
import type { Database, Row } from "../store/database.ts"
import { goalOfWorkflow } from "../store/goals.ts"
import { newId } from "../store/ids.ts"
import {
  activeWorkflowForRequest,
  candidateManifest,
  createWorkflow,
  frozenFiles,
  lastRefusal,
  latestWorkflow,
  loadPlan,
  loadRequest,
  loadReviews,
  loadTasks,
  loadWorkflow,
  recordArbitration,
  recordCandidate,
  requestDigestOf,
  saveWorkflow,
  savePlan,
  setTaskState,
  submitReview,
  type StoredWorkflow,
} from "../store/workflows.ts"
import { apply, isTerminal, TransitionError, type WorkflowCommand } from "./machine.ts"
import { parsePlan } from "./plan.ts"
import { route, type Preference } from "./routing.ts"
import { insideAny } from "./scopes.ts"
import { parseVerdict, type Verdict } from "./verdicts.ts"

export interface ServiceContext {
  /** Carried so `start` can state the per-role configuration rather than be told it. */
  readonly configuration: Configuration
  readonly database: Database
  readonly dataDirectory: string
  readonly maxRepairCycles: number
  readonly projectId: string
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowError"
  }
}

/**
 * The per-role configuration, returned by `start` so the run never depends on its caller having
 * assembled it. The skill is told to call `role_settings` once per role and pass a map; when that
 * preamble is skipped the map arrives empty, every role inherits the session model, and nothing
 * anywhere says so — the product's central promise fails silently. The plane holds the
 * configuration, so the plane states it.
 */
function roleModels(configuration: Configuration): Record<string, WorkflowRoleSetting> {
  const roles: Record<string, WorkflowRoleSetting> = {}
  for (const role of ROLES) {
    const resolved = resolveRole(configuration, role)
    roles[WORKFLOW_ROLE_NAME[role] ?? role] = {
      effort: resolved.effort,
      model: resolved.model,
      // The workflow runtime dispatches on the identifier as configured, which is what keeps a
      // third-party model reachable at all. The family is carried for the advisory commands,
      // which dispatch through a tool that accepts nothing else.
      subagentModel: resolved.subagentModel,
    }
  }
  return roles
}

export interface WorkflowRoleSetting {
  readonly effort: string
  readonly model: string | null
  readonly subagentModel: string | null
}

/** The names the workflow script dispatches by, which differ from the stored role names. */
const WORKFLOW_ROLE_NAME: Readonly<Record<string, string>> = {
  functional_reviewer: "functional-reviewer",
  security_reviewer: "security-reviewer",
}

export function startWorkflow(
  context: ServiceContext,
  request: string,
  affectedPaths: readonly string[],
  preference: Preference,
  now = Date.now(),
): unknown {
  const text = request.trim()
  if (!text) throw new WorkflowError("a workflow needs the user's exact request")

  // A caller once handed over its whole argument list as the request:
  // `request="add a discount..." workflowId="e84cde16-..."`. That opened a second workflow on a
  // mangled sentence and orphaned the real one, and the arbiter would have judged the delivered
  // work against the serialisation rather than against what the user asked for. Nothing legitimate
  // begins this way, so it is refused rather than tidied up: a request the plane silently repaired
  // is a request nobody can be held to.
  if (/^request\s*=/iu.test(text)) {
    throw new WorkflowError(
      "that request is an argument list, not a request: it begins with `request=`. Pass the user's " +
        "sentence itself as `request`. The arbiter judges the delivered work against this text, so " +
        "a serialisation here would be judged literally.",
    )
  }

  // A relayed start whose response was lost comes back as an identical call. Rejoining the run it
  // already created is the only safe answer: a second workflow would fork the work, and both halves
  // would look healthy while neither was the whole.
  const existing = activeWorkflowForRequest(
    context.database,
    context.projectId,
    requestDigestOf(text),
  )
  if (existing !== undefined) {
    const decision = route(text, affectedPaths, preference)
    return {
      critical: decision.critical,
      goalId: goalOfWorkflow(context.database, existing.id) ?? null,
      mode: existing.mode ?? decision.mode,
      rationale: decision.rationale,
      requestDigest: requestDigestOf(text),
      resumed: true,
      roles: roleModels(context.configuration),
      state: existing.state,
      workflowId: existing.id,
    }
  }

  const { id, requestDigest } = createWorkflow(
    context.database,
    context.projectId,
    text,
    context.maxRepairCycles,
    now,
  )
  const decision = route(text, affectedPaths, preference)

  let workflow = load(context, id)
  workflow = transition(context, workflow, { type: "complete_intake" }, now)
  workflow = transition(context, workflow, { mode: decision.mode, type: "route" }, now)

  const goalId = linkStartedWorkflow(context, id, text, now)
  record(context, id, "workflow.started", {
    mode: decision.mode,
    rationale: decision.rationale,
    request_digest: requestDigest,
    ...(goalId === null ? {} : { goal: goalId }),
  })

  return {
    critical: decision.critical,
    goalId,
    mode: decision.mode,
    rationale: decision.rationale,
    requestDigest,
    resumed: false,
    roles: roleModels(context.configuration),
    state: workflow.state,
    workflowId: id,
  }
}

/**
 * One line, built from the record, that says what actually happened. It exists because the layer
 * that tells the user about a run is prose written by a model, and prose drifts: a workflow stopped
 * in delivery on the quick route with no reviews has been reported as "completed, full cycle, seven
 * agents", and work done outside the cycle entirely has been reported as ready. The plane cannot
 * stop a caller paraphrasing, but it can hand it a sentence that is either quoted exactly or
 * visibly not quoted at all.
 */
function recordSummary(context: ServiceContext, workflow: StoredWorkflow): string {
  const database = context.database
  const counted = (table: string, column: string): number => {
    const row = database.get<Row>(
      `select count(*) as total from ${table} where ${column} = ?`,
      workflow.id,
    )
    return Number(row?.["total"] ?? 0)
  }

  const tasks = loadTasks(database, workflow.id)
  const done = tasks.filter((task) => task.state === "completed").length
  const delivered = counted("deliveries", "workflow_id") > 0

  return [
    `route ${workflow.mode ?? "unrouted"}`,
    `state ${workflow.state}`,
    `tasks ${done}/${tasks.length}`,
    `reviews ${counted("reviews", "workflow_id")}`,
    `arbitrations ${counted("arbitrations", "workflow_id")}`,
    `repair ${workflow.repairCycles}/${workflow.maxRepairCycles}`,
    delivered ? "delivered" : "not delivered",
    // A run whose plane received no option at all is running on the session model for every role,
    // whatever the user configured. The doctor says so; a run said nothing, so a stale server was
    // indistinguishable from a deliberate choice to inherit. It rides the line every report quotes.
    // The workflow script matches on this prefix, so both shapes of the failure keep it verbatim.
    ...(context.configuration.delivered === 0
      ? [
          context.configuration.blank > 0
            ? `no plugin option reached this process with a value (${context.configuration.blank} arrived empty)`
            : "no plugin option reached this process",
        ]
      : []),
  ].join(" · ")
}

export function workflowStatus(context: ServiceContext, workflowId?: string): unknown {
  const workflow =
    workflowId === undefined
      ? latestWorkflow(context.database, context.projectId)
      : loadWorkflow(context.database, workflowId)
  if (workflow === undefined) return { found: false }

  const request = loadRequest(context.database, workflow.id)
  return {
    found: true,
    // What the last refusal said, carried so a repair is aimed rather than blind. Empty until
    // something has actually been refused.
    lastRefusal: lastRefusal(context.database, workflow.id),
    mode: workflow.mode,
    originalRequest: request?.originalText ?? null,
    pausedBecause: pausedBecause(context, workflow),
    repair: { max: workflow.maxRepairCycles, used: workflow.repairCycles },
    requestDigest: request?.digest ?? null,
    // Quoted verbatim by every skill that reports a run, so a paraphrase is visible as one.
    summary: recordSummary(context, workflow),
    // Which model each role is set to run on, so "were my models used" is a question the plane
    // answers rather than one the user has to reconstruct from a transcript.
    roles: roleModels(context.configuration),
    state: workflow.state,
    tasks: loadTasks(context.database, workflow.id).map((task) => ({
      key: task.key,
      state: task.state,
      title: task.title,
      writeScopes: task.writeScopes,
    })),
    terminal: isTerminal(workflow.state),
    workflowId: workflow.id,
  }
}

export function submitPlan(
  context: ServiceContext,
  workflowId: string,
  raw: unknown,
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)
  if (workflow.state !== "architecture") {
    throw new WorkflowError(`a plan is only accepted in architecture, not ${workflow.state}`)
  }

  const plan = parsePlan(raw)
  savePlan(context.database, workflowId, plan, now)
  const next = transition(context, workflow, { type: "architecture_accepted" }, now)

  record(context, workflowId, "architecture.accepted", {
    requirements: String(plan.requirements.length),
    tasks: String(plan.tasks.length),
  })

  return {
    requirements: plan.requirements.map((entry) => entry.id),
    state: next.state,
    tasks: plan.tasks.map((task) => ({ key: task.key, writeScopes: task.writeScopes })),
  }
}

/**
 * `changedPaths` is the worktree as git reports it, supplied by the caller because only it can
 * reach the filesystem. Section 5.2 layer three: the executor's own account of what it did is
 * never the record of what it did.
 */
export function reportTask(
  context: ServiceContext,
  workflowId: string,
  key: string,
  status: "blocked" | "completed" | "plan_defect",
  summary: string,
  /**
   * What the worktree says this task wrote, or null when git could not be read at all. Null is not
   * an empty change set: flattening the two is how a transient git failure let a task with
   * out-of-scope writes report as completed, with the scope gate never running.
   */
  changedPaths: readonly string[] | null = [],
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)

  if (status === "completed") {
    if (changedPaths === null) {
      record(context, workflowId, "execution.change_set_unreadable", { task: key })
      return {
        reason:
          "the change set could not be read, so this task's writes cannot be reconciled against " +
          "the scopes the plan authorized. Nothing has been recorded as completed. Report the " +
          "task again.",
        retry: true,
        state: workflow.state,
      }
    }
    const violations = outOfScope(context, workflowId, key, changedPaths)
    if (violations.length !== 0) {
      setTaskState(context.database, workflowId, key, "blocked", now)
      record(context, workflowId, "execution.scope_violation", {
        paths: violations.slice(0, 20).join(", "),
        task: key,
      })
      const next = transition(
        context,
        workflow,
        { target: "execution", type: "execution_failed" },
        now,
      )
      const pending = pendingOwners(context, workflowId, key, violations)
      return {
        outOfScope: violations,
        reason:
          pending.length === 0
            ? `the task changed ${violations.length} path(s) outside every write scope the plan ` +
              "authorized"
            : `the task changed path(s) owned by ${pending.join(", ")}, which have not been ` +
              "reported yet. Report each task as it is completed, before starting the next one. " +
              "Do not move the changes aside to get past this: the paths are authorized, the " +
              "order is not.",
        state: next.state,
        unreportedTasks: pending,
      }
    }
  }

  setTaskState(context.database, workflowId, key, status, now)
  record(context, workflowId, `execution.task_${status}`, { summary: summary.slice(0, 2_000), task: key })

  if (status === "plan_defect") {
    const next = transition(context, workflow, { type: "replan" }, now)
    return { state: next.state }
  }
  if (status === "blocked") {
    const next = transition(context, workflow, { target: "execution", type: "execution_failed" }, now)
    return { state: next.state }
  }

  const remaining = loadTasks(context.database, workflowId).filter(
    (task) => task.state !== "completed",
  )
  return { remaining: remaining.map((task) => task.key), state: workflow.state }
}

/**
 * Authorization is the union of the scopes of the task being reported and of every task already
 * completed, because a later task otherwise reconciles against files an earlier one legitimately
 * wrote. That is coarser than per-task attribution and is the deliberate ceiling: it still catches
 * the boundary that matters — a path no task in the plan was allowed to touch — with no snapshot
 * to keep in step. A quick-route workflow has no plan and therefore authorizes nothing here; its
 * candidate is bounded by the freeze and the gates instead.
 */
/**
 * Of the violating paths, the tasks that do authorize them but have not been reported. The
 * distinction matters at the point of refusal: "no task may touch this" and "this task may not
 * touch it yet" call for opposite responses, and a caller told the first when the second is true
 * will move the files aside rather than report the work in order.
 */
function pendingOwners(
  context: ServiceContext,
  workflowId: string,
  key: string,
  violations: readonly string[],
): string[] {
  const owners = new Set<string>()
  for (const task of loadTasks(context.database, workflowId)) {
    if (task.key === key || task.state === "completed") continue
    if (violations.some((path) => insideAny(path, task.writeScopes))) owners.add(task.key)
  }
  return [...owners].sort()
}

function outOfScope(
  context: ServiceContext,
  workflowId: string,
  key: string,
  changedPaths: readonly string[],
): string[] {
  const tasks = loadTasks(context.database, workflowId)
  if (tasks.length === 0) return []

  const authorized = tasks
    .filter((task) => task.key === key || task.state === "completed")
    .flatMap((task) => task.writeScopes)

  return changedPaths.filter((path) => !insideAny(path, authorized)).sort()
}

export function freezeCandidate(
  context: ServiceContext,
  workflowId: string,
  captured: CapturedCandidate,
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)
  const candidateId = newId()
  const candidateDigest = recordCandidate(context.database, workflowId, candidateId, captured, now)
  const next = transition(context, workflow, { candidateId, type: "candidate_ready" }, now)

  record(context, workflowId, "candidate.frozen", {
    base_revision: captured.manifest.baseRevision,
    candidate: candidateId,
    diff_digest: captured.manifest.diffDigest,
    digest: candidateDigest,
    files: String(captured.manifest.files.length),
  })
  return {
    baseRevision: captured.manifest.baseRevision,
    candidateDigest,
    candidateId,
    // One secret per reviewing role, returned exactly once. The run hands each to that role alone,
    // which is what lets the plane know who captured a flow instead of being told.
    captureCapabilities: issueCaptureCapabilities(context.database, workflowId, candidateId, now),
    files: captured.manifest.files.length,
    state: next.state,
  }
}

/**
 * Promotion, then the transition. In that order: the state machine only records that delivery
 * happened, and a delivery that aborted must not leave a workflow claiming it completed.
 */
export async function deliverCandidate(
  context: ServiceContext,
  workflowId: string,
  root: string,
  now = Date.now(),
): Promise<unknown> {
  const workflow = load(context, workflowId)
  if (workflow.state !== "delivery") {
    throw new WorkflowError(`delivery is only accepted in delivery, not ${workflow.state}`)
  }
  const candidateId = requireCandidate(workflow)

  let outcome
  try {
    outcome = await promote(
      context.database,
      root,
      workflowId,
      candidateId,
      deliveryMessage(context, workflowId, candidateId),
      now,
    )
  } catch (error) {
    if (!(error instanceof DeliveryAborted)) throw error
    record(context, workflowId, "delivery.aborted", { reason: error.message })
    return { aborted: error.message, state: workflow.state }
  }

  const next = transition(context, workflow, { type: "deliver" }, now)
  const learned = captureDelivery(
    context,
    {
      candidateId,
      files: outcome.delivered,
      request: loadRequest(context.database, workflowId)?.originalText ?? "",
      revision: outcome.revision,
      workflowId,
    },
    now,
  )
  const goal = advanceGoalOfWorkflow(context, workflowId, now)
  record(context, workflowId, "delivery.completed", {
    memories: String(learned.length),
    ...(goal === null ? {} : { goal: goal.goalId, goal_blocked: String(goal.blocked) }),
    files: String(outcome.delivered.length),
    revision: outcome.revision,
    verified_only: String(outcome.verifiedOnly.length),
  })
  signCheckpoint(context.database, context.dataDirectory, now)

  return { ...outcome, goal, state: next.state }
}

/**
 * `/cycle:resume` after the application restarted. The session that was driving the workflow is
 * gone; the workflow is not. Reports where it stopped, finishes a delivery a crash interrupted, and
 * says what happens next rather than guessing it.
 */
export async function reconcile(
  context: ServiceContext,
  root: string,
  workflowId?: string,
  now = Date.now(),
): Promise<unknown> {
  const workflow =
    workflowId === undefined
      ? latestWorkflow(context.database, context.projectId)
      : loadWorkflow(context.database, workflowId)
  if (workflow === undefined || workflow.projectId !== context.projectId) {
    return { found: false, next: "nothing to resume in this project" }
  }

  let recovered = null
  if (workflow.state === "delivery") {
    try {
      recovered = await recoverDelivery(
        context.database,
        root,
        workflow.id,
        deliveryMessage(context, workflow.id, workflow.candidateId ?? ""),
        now,
      )
      if (recovered !== null) {
        transition(context, workflow, { type: "deliver" }, now)
        record(context, workflow.id, "delivery.recovered", {
          files: String(recovered.delivered.length),
          revision: recovered.revision,
        })
        signCheckpoint(context.database, context.dataDirectory, now)
      }
    } catch (error) {
      record(context, workflow.id, "delivery.aborted", {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const current = loadWorkflow(context.database, workflow.id)!
  return {
    chain: verifyHistory(context.database).valid && verifyCheckpoints(context.database).valid,
    delivery: deliveryOf(context.database, workflow.id) ?? null,
    found: true,
    next: NEXT_ACTION[current.state],
    // Carried so that continuing a run does not require the user to retype the request the arbiter
    // will judge it against. Retyping it is how a requirement gets silently rewritten.
    originalRequest: loadRequest(context.database, workflow.id)?.originalText ?? null,
    pausedBecause: pausedBecause(context, current),
    recovered,
    repair: { max: current.maxRepairCycles, used: current.repairCycles },
    state: current.state,
    workflowId: current.id,
  }
}

/**
 * A blocked workflow is knowledge: the next architect can avoid the approach that ran out of
 * repair cycles. Recorded once, when the budget is exhausted, never on the way there.
 */
function rememberIfBlocked(
  context: ServiceContext,
  workflowId: string,
  next: StoredWorkflow,
  candidateId: string | null,
  now: number,
): void {
  if (next.state !== "blocked" || candidateId === null) return
  captureBlocked(
    context,
    {
      candidateId,
      cycles: next.repairCycles,
      files: frozenFiles(context.database, candidateId).map((file) => file.path),
      request: loadRequest(context.database, workflowId)?.originalText ?? "",
      workflowId,
    },
    now,
  )
}

/** What this project already learned about a request, before anybody plans against it. */
export function recallForRequest(
  context: ServiceContext,
  request: string,
  paths: readonly string[] = [],
): unknown {
  return { memories: recall(context, request, paths) }
}

/**
 * The commit message: the user's own request first, because that is the text the arbiter
 * judged against, then what makes the delivery auditable a year later.
 */
function deliveryMessage(
  context: ServiceContext,
  workflowId: string,
  candidateId: string,
): string {
  const request = loadRequest(context.database, workflowId)
  const manifest = candidateManifest(context.database, candidateId)
  if (manifest === undefined) {
    throw new WorkflowError("this candidate has no recorded manifest to commit against")
  }
  return commitMessage(request?.originalText ?? "deliver approved candidate", manifest, workflowId)
}

/** What a person, or a fresh session, has to do next from each state. */
const NEXT_ACTION: Readonly<Record<string, string>> = {
  arbitration: "run /cycle:run again to re-dispatch the arbiter against the frozen candidate",
  architecture: "run /cycle:run again: the architect must produce a plan",
  blocked: "the repair budget is exhausted; /cycle:retry extends it",
  cancelled: "nothing: this workflow was cancelled",
  completed: "nothing: this workflow was delivered",
  delivery: "delivery was interrupted and could not be finished; inspect the working tree",
  execution: "run /cycle:run again: the executor must finish its tasks",
  independent_reviews: "run /cycle:run again to re-dispatch the reviewers",
  intake: "run /cycle:run to route this request",
  paused: "/cycle:resume returns it to where it paused",
  quick_execution: "run /cycle:run again: the executor must finish its tasks",
  repair: "/cycle:run continues the repair cycle",
  routing: "run /cycle:run to route this request",
  verification: "run /cycle:run again: the gates must run against the frozen candidate",
}

/** The chain and its signatures, for `/cycle:history verify` and for startup. */
export function historyState(context: ServiceContext, limit = 50, after?: number): unknown {
  return {
    chain: verifyHistory(context.database),
    checkpoint: latestCheckpoint(context.database) ?? null,
    entries: readHistory(context.database, context.projectId, after ?? null, Math.min(limit, 500)).map(
      (entry) => ({
        action: entry.action,
        actor: entry.actor,
        candidate: entry.candidateId,
        hash: entry.hash,
        metadata: entry.metadata,
        recordedAt: entry.recordedAt,
        role: entry.role,
        sequence: entry.sequence,
        workflow: entry.workflowId,
      }),
    ),
    signatures: verifyCheckpoints(context.database),
  }
}

/**
 * The outcome comes from the evidence engine, which derives it from recorded gate results. This
 * function only moves the workflow: it never decides whether anything passed.
 */
export function verifyCandidate(
  context: ServiceContext,
  workflowId: string,
  outcome: VerificationOutcome,
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)
  if (workflow.state !== "verification") {
    throw new WorkflowError(`verification is only accepted in verification, not ${workflow.state}`)
  }

  record(context, workflowId, "verification.completed", {
    mandatory_passed: String(outcome.mandatoryPassed),
    reason: outcome.reason,
  })

  const next = outcome.mandatoryPassed
    ? transition(context, workflow, { type: "verification_passed" }, now)
    : transition(context, workflow, { target: "execution", type: "verification_failed" }, now)
  rememberIfBlocked(context, workflowId, next, workflow.candidateId, now)

  return { mandatoryPassed: outcome.mandatoryPassed, reason: outcome.reason, state: next.state }
}

/**
 * The evidence recorded for the current candidate. Reviewers and the arbiter may cite only these
 * identifiers, so they have to be handed the list rather than asked to remember one.
 */
export function candidateEvidence(context: ServiceContext, workflowId: string): unknown {
  const workflow = load(context, workflowId)
  // The requirement identifiers a verdict is allowed to cite. A reviewer is asked to decide every
  // requirement in the plan and a verdict citing an identifier the plan does not contain is
  // refused, so the plan's own identifiers are handed out with the evidence rather than left to be
  // guessed. A quick-route workflow has no plan and therefore no matrix: the list is empty and the
  // arbiter judges the original request directly.
  const requirements = loadPlan(context.database, workflowId)?.requirements.map((entry) => entry.id) ?? []

  if (workflow.candidateId === null) return { candidate: null, evidence: [], requirements }
  return {
    candidate: workflow.candidateId,
    evidence: loadEvidence(context.database, workflow.candidateId).map((item) => ({
      gate: item.gateName,
      id: item.id,
      mandatory: item.mandatory,
      reason: item.skipReason,
      status: item.status,
    })),
    requirements,
  }
}

/** What the evidence engine needs to verify this workflow's frozen candidate. */
export function verificationInputs(
  context: ServiceContext,
  workflowId: string,
): { candidateId: string; taskCommands: readonly string[] } {
  const workflow = load(context, workflowId)
  return {
    candidateId: requireCandidate(workflow),
    taskCommands: loadTasks(context.database, workflowId).flatMap(
      (task) => task.verificationCommands,
    ),
  }
}

export function submitReviewVerdict(
  context: ServiceContext,
  workflowId: string,
  role: "functional_reviewer" | "security_reviewer",
  raw: unknown,
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)
  if (workflow.state !== "independent_reviews") {
    throw new WorkflowError(`a review is only accepted in independent_reviews, not ${workflow.state}`)
  }
  const candidateId = requireCandidate(workflow)
  const verdict = parseVerdict(raw, verdictContext(context, workflowId, role))

  const { reviewsReady } = submitReview(
    context.database,
    workflowId,
    candidateId,
    role,
    verdict,
    now,
  )
  record(context, workflowId, "review.submitted", { decision: verdict.decision, role })

  let next = workflow
  if (reviewsReady) next = transition(context, workflow, { type: "reviews_ready" }, now)
  return { decision: verdict.decision, reviewsReady, state: next.state }
}

/**
 * Records one captured browser flow as the interface layer's evidence. Accepted only while a frozen
 * candidate exists, because an attestation that is not bound to a candidate attests to nothing.
 */
export function submitBrowserEvidence(
  context: ServiceContext,
  workflowId: string,
  raw: unknown,
  /**
   * The secret issued to a reviewing role when the candidate was frozen. No token means the
   * executor reporting its own work, which is recorded and carries no weight. A token that does not
   * redeem is refused outright rather than quietly downgraded: something tried to authenticate and
   * failed, and treating that as an ordinary self-report would hide it.
   */
  captureToken: string | null = null,
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)
  if (workflow.state !== "verification" && workflow.state !== "independent_reviews") {
    throw new WorkflowError(
      `browser evidence is accepted while the candidate is being verified or reviewed, not in ${workflow.state}`,
    )
  }
  const candidateId = requireCandidate(workflow)

  let capturedBy: CapturedBy = "executor"
  if (captureToken !== null) {
    const redeemed = redeemCaptureCapability(context.database, candidateId, captureToken, now)
    if (redeemed.role === null) {
      throw new WorkflowError(
        `this capture capability is ${redeemed.reason === "consumed" ? "already spent" : "not valid for this candidate"}. ` +
          "It is issued to one reviewing role when the candidate is frozen and can be spent once. " +
          "Submit without it to record a self-reported capture, which carries no weight.",
      )
    }
    capturedBy = redeemed.role
  }

  const snapshot = parseSnapshot(raw)
  const { evidence, findings } = browserEvidence(snapshot, capturedBy, now)
  recordEvidence(context.database, candidateId, evidence, (item) => item.gate.mandatory)

  record(context, workflowId, "browser.captured", {
    capturedBy,
    findings: String(findings.length),
    flow: snapshot.capturedFlow.slice(0, 200),
    url: snapshot.url.slice(0, 500),
  })

  return {
    accessibility: findings,
    // Said back, so a caller learns what its submission was credited as rather than assuming.
    capturedBy,
    evidenceIds: evidence.map((item) => item.id),
    state: workflow.state,
  }
}

/**
 * Runs one security proof against a disposable copy of the candidate and records the result. The
 * security reviewer calls this before it may raise a critical or high finding; see section 7.7.
 */
export async function submitSecurityProof(
  context: ServiceContext,
  workflowId: string,
  root: string,
  request: ProofRequest & { rationale: string; vulnerabilityClass: string },
  now = Date.now(),
): Promise<unknown> {
  const workflow = load(context, workflowId)
  if (workflow.state !== "independent_reviews" && workflow.state !== "arbitration") {
    throw new WorkflowError(
      `a proof is run while the candidate is under review, not in ${workflow.state}`,
    )
  }
  if (!context.configuration.securityProofs) {
    throw new WorkflowError(
      "executing a proof is off. A proof runs code supplied by the reviewer against a copy of the " +
        "candidate, with this account's privileges and no operating-system sandbox, so it is " +
        "enabled deliberately: set the plugin's security_proofs option to on. Until then, state " +
        "the vulnerability and the reasoning in the review; an undemonstrated critical is " +
        "downgraded, not discarded.",
    )
  }
  const candidateId = requireCandidate(workflow)
  const gateName = proofGateName(request.vulnerabilityClass)
  const rationale = request.rationale.trim().slice(0, 2_000)
  if (!rationale) throw new WorkflowError("a proof must say what it is trying to demonstrate")

  const result = await runProof(root, {
    ...(request.command === undefined ? {} : { command: request.command }),
    ...(request.interpreter === undefined ? {} : { interpreter: request.interpreter }),
    ...(request.script === undefined ? {} : { script: request.script }),
  })
  const evidence = proofEvidence(request.vulnerabilityClass, rationale, result, now)
  recordEvidence(context.database, candidateId, [evidence], (item) => item.gate.mandatory)

  record(context, workflowId, `security.proof_${result.demonstrated ? "demonstrated" : "inconclusive"}`, {
    gate: gateName,
    rationale,
  })

  return {
    containment: result.containment,
    demonstrated: result.demonstrated,
    evidenceId: evidence.id,
    exitCode: evidence.exitCode,
    gate: gateName,
    output: evidence.output.slice(0, 8_000),
    status: evidence.status,
  }
}

/**
 * Whether the recorded gates permit an approval. Read from the evidence table, never from a caller:
 * an arbiter's verdict decides whether the work is right, not whether the gates ran. Scoped to the
 * workflow's current candidate, so a repaired candidate is judged on its own gates and the evidence
 * of the candidate it replaced stays in the record without condemning it.
 */
export function mandatoryGatesPassed(context: ServiceContext, workflowId: string): boolean {
  const row = context.database.get<{ failed: number; total: number }>(
    `select count(*) as total, sum(case when e.status != 'passed' then 1 else 0 end) as failed
       from evidence e join workflows w on w.candidate_id = e.candidate_id
      where w.id = ? and e.mandatory = 1`,
    workflowId,
  )
  return (row?.total ?? 0) > 0 && (row?.failed ?? 0) === 0
}

export function arbitrate(
  context: ServiceContext,
  workflowId: string,
  raw: unknown,
  mandatoryPassed: boolean,
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)
  if (workflow.state !== "arbitration") {
    throw new WorkflowError(`arbitration is only accepted in arbitration, not ${workflow.state}`)
  }
  const candidateId = requireCandidate(workflow)
  const verdict = parseVerdict(raw, verdictContext(context, workflowId, "arbiter"))

  if (workflow.mode === "full") {
    const reviews = loadReviews(context.database, candidateId)
    if (reviews.length < 2) throw new WorkflowError("arbitration requires both independent reviews")
    if (verdict.decision === "approved" && reviews.some((r) => r.verdict.decision === "rejected")) {
      throw new WorkflowError("arbitration cannot approve while a reviewer rejected the candidate")
    }
  }

  const receiptDigest = recordArbitration(context.database, workflowId, candidateId, verdict, now)


  let next: StoredWorkflow
  let refusal: string | null = null
  if (verdict.decision === "approved") {
    try {
      next = transition(context, workflow, { mandatoryGatesPassed: mandatoryPassed, type: "approve" }, now)
    } catch (error) {
      if (!(error instanceof TransitionError) || error.code !== "gates_not_passed") throw error
      refusal = error.message
      next = transition(context, workflow, { target: "execution", type: "reject" }, now)
    }
  } else {
    next = transition(context, workflow, { target: verdict.repairTarget ?? "execution", type: "reject" }, now)
  }

  record(context, workflowId, `arbitration.${refusal === null ? verdict.decision : "refused"}`, {
    receipt_digest: receiptDigest,
    ...(refusal === null ? {} : { refusal }),
  })
  rememberIfBlocked(context, workflowId, next, candidateId, now)

  return {
    decision: verdict.decision,
    receiptDigest,
    refusal,
    repair: { max: next.maxRepairCycles, used: next.repairCycles },
    state: next.state,
  }
}

/**
 * `reason` classifies why the operation was issued and is kept with it in the chain. A workflow
 * paused because a provider stopped answering is a different thing from one a user paused, and
 * the difference has to survive the session that noticed it.
 */
export function control(
  context: ServiceContext,
  workflowId: string,
  operation: "cancel" | "pause" | "repair" | "resume" | "retry",
  reason?: string,
  now = Date.now(),
): unknown {
  const workflow = load(context, workflowId)
  const command: WorkflowCommand = COMMANDS[operation] ?? { type: operation as "cancel" }

  const next = transition(context, workflow, command, now)
  const classification = reason?.trim().slice(0, MAX_REASON)
  record(context, workflowId, `control.${operation}`, classification ? { reason: classification } : {})
  // A cancelled workflow is terminal, so the chain is anchored where it ended.
  if (operation === "cancel") signCheckpoint(context.database, context.dataDirectory, now)
  // The caller resumes at the returned state: a repair sends the work back to architecture or to
  // execution depending on what the rejection blamed, and only the control plane knows which.
  return {
    repairTarget: workflow.repairTarget,
    ...(classification ? { reason: classification } : {}),
    state: next.state,
  }
}

const MAX_REASON = 512

/** Why the workflow is standing still, read back from the chain rather than held in memory. */
function pausedBecause(context: ServiceContext, workflow: StoredWorkflow): string | null {
  if (workflow.state !== "paused") return null
  return lastEvent(context.database, workflow.id, "control.pause")?.metadata["reason"] ?? null
}

const COMMANDS: Readonly<Record<string, WorkflowCommand>> = {
  cancel: { type: "cancel" },
  pause: { type: "pause" },
  repair: { type: "begin_repair" },
  resume: { type: "resume" },
  retry: { additionalCycles: 1, type: "resume_blocked" },
}

// The quick route has no architect and therefore no requirement matrix: the arbiter judges the
// original request directly. A full-route workflow cannot reach here without a plan, because
// architecture_accepted is the only way out of architecture.
function verdictContext(context: ServiceContext, workflowId: string, role: string) {
  const workflow = load(context, workflowId)
  const plan = loadPlan(context.database, workflowId)
  // Only the current candidate's evidence. Citing a gate that ran against the candidate this one
  // replaced would attach a verdict to work that is no longer on disk.
  const evidence = context.database.all<{ id: string }>(
    "select e.id from evidence e join workflows w on w.candidate_id = e.candidate_id where w.id = ?",
    workflowId,
  )
  // Section 7.7: the security reviewer may not report a vulnerability class as present without an
  // executed proof. Only a demonstrated proof — a failing proof gate — counts.
  const proofIds = loadEvidence(context.database, workflow.candidateId ?? "")
    .filter((item) => item.gateName.startsWith("security:proof:") && item.status === "failed")
    .map((item) => item.id)

  return {
    evidenceIds: evidence.map((row) => row.id),
    proofIds,
    requirementIds: plan?.requirements.map((entry) => entry.id) ?? [],
    requiresProof: role === "security_reviewer",
    role,
  }
}

function transition(
  context: ServiceContext,
  workflow: StoredWorkflow,
  command: WorkflowCommand,
  now: number,
): StoredWorkflow {
  const next = { ...workflow, ...apply(workflow, command) }
  saveWorkflow(context.database, next, now)
  // A workflow that cannot proceed holds no slot. Releasing here rather than at each call site
  // means no path can forget, and a lease would otherwise sit until it expired.
  if (isTerminal(next.state) || next.state === "blocked" || next.state === "paused") {
    release(context.database, next.id)
  }
  return next
}

function load(context: ServiceContext, workflowId: string): StoredWorkflow {
  const workflow = loadWorkflow(context.database, workflowId)
  if (workflow === undefined) throw new WorkflowError(`unknown workflow: ${workflowId}`)
  if (workflow.projectId !== context.projectId) {
    throw new WorkflowError("that workflow belongs to another project")
  }
  return workflow
}

function requireCandidate(workflow: StoredWorkflow): string {
  if (workflow.candidateId === null) throw new WorkflowError("this workflow has no frozen candidate")
  return workflow.candidateId
}

/** Anchors the chain regularly, so a project that has not delivered yet is still signed. */
const CHECKPOINT_EVERY = 100

function record(
  context: ServiceContext,
  workflowId: string,
  action: string,
  metadata: Record<string, string>,
): void {
  const entry = appendHistory(
    context.database,
    { action, actor: "cycle", metadata, projectId: context.projectId, workflowId },
    Date.now(),
  )
  if (entry.sequence % CHECKPOINT_EVERY === 0) {
    signCheckpoint(context.database, context.dataDirectory)
  }
}

export type { Verdict }

const EXPORT_LIMIT = 5_000

/**
 * `/cycle:export`. Returns the record rather than writing it: the plugin has no business choosing
 * a path on the user's disk, and a caller that asked for this can write what it was handed. Bounded
 * and explicit about it — a truncated export that said nothing would be a record of nothing.
 */
export function exportState(
  context: ServiceContext,
  kind: "evidence" | "history" | "state",
  workflowId?: string,
): unknown {
  if (kind === "history") {
    const entries = readHistory(context.database, context.projectId, null, EXPORT_LIMIT)
    const total = context.database.get<{ entries: number }>(
      "select count(*) as entries from history where project_id = ?",
      context.projectId,
    )
    return {
      chain: verifyHistory(context.database),
      entries,
      kind,
      truncated: Number(total?.entries ?? 0) > entries.length,
    }
  }

  if (kind === "evidence") {
    const workflow = resolveForExport(context, workflowId)
    return {
      candidateId: workflow.candidateId,
      evidence: loadEvidence(context.database, workflow.candidateId ?? ""),
      kind,
      workflowId: workflow.id,
    }
  }

  const workflow = resolveForExport(context, workflowId)
  return {
    kind,
    plan: loadPlan(context.database, workflow.id),
    request: loadRequest(context.database, workflow.id),
    reviews: loadReviews(context.database, workflow.candidateId ?? ""),
    tasks: loadTasks(context.database, workflow.id),
    workflow: {
      candidateId: workflow.candidateId,
      mode: workflow.mode,
      repair: { max: workflow.maxRepairCycles, used: workflow.repairCycles },
      state: workflow.state,
      workflowId: workflow.id,
    },
  }
}

function resolveForExport(context: ServiceContext, workflowId?: string): StoredWorkflow {
  const workflow =
    workflowId === undefined
      ? latestWorkflow(context.database, context.projectId)
      : loadWorkflow(context.database, workflowId)
  if (workflow === undefined || workflow.projectId !== context.projectId) {
    throw new WorkflowError("there is no such workflow in this project")
  }
  return workflow
}
