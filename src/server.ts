import { readFileSync } from "node:fs"
import { join } from "node:path"

import { release } from "./admission.ts"
import { ROLES, type Role } from "./config.ts"
import { diagnose } from "./diagnostics.ts"
import { captureCandidate } from "./evidence/candidate.ts"
import { changedFiles } from "./evidence/changes.ts"
import { verify } from "./evidence/engine.ts"
import { indexProject } from "./intel/indexer.ts"
import { findSymbol, impactOf, neighboursOf, scopeBundle } from "./intel/query.ts"
import {
  abort,
  advance,
  amend,
  approveCompletion,
  currentPlan,
  extend,
  focus as focusGoalById,
  goals,
  link,
  newGoal,
  pause as pauseGoal,
  plan as planGoal,
  requestCompletion,
  resume as resumeGoal,
  status as goalStatus,
} from "./goals.ts"
import { chainOf, explain, forget, recall } from "./memory.ts"
import { serve, type ToolDefinition } from "./mcp.ts"
import { verifyCheckpoints } from "./store/checkpoints.ts"
import { verifyHistory } from "./store/history.ts"
import { renderDoctor } from "./report.ts"
import { BOUNDARIES, CONSULTATION, resolveConsultation } from "./roles.ts"
import { Runtime } from "./runtime.ts"
import { graphSize } from "./store/graph.ts"
import { appendHistory } from "./store/history.ts"
import {
  arbitrate,
  candidateEvidence,
  exportState,
  control,
  deliverCandidate,
  historyState,
  mandatoryGatesPassed,
  recallForRequest,
  reconcile,
  freezeCandidate,
  reportTask,
  startWorkflow,
  submitPlan,
  submitBrowserEvidence,
  submitReviewVerdict,
  submitSecurityProof,
  verificationInputs,
  verifyCandidate,
  type ServiceContext,
  workflowStatus,
} from "./workflow/service.ts"

/**
 * Read from the manifest rather than written here. A literal drifts the moment a release bumps the
 * manifest and forgets this line, and a doctor reporting a version the code is not is worse than
 * one reporting none: it was read as proof that a stale process was answering, and sent the reader
 * hunting a delivery bug that did not exist.
 */
const VERSION = manifestVersion()

function manifestVersion(): string {
  try {
    const manifest = join(import.meta.dirname, "..", "package.json")
    const version = JSON.parse(readFileSync(manifest, "utf8")).version
    return typeof version === "string" && version.length > 0 ? version : "unknown"
  } catch {
    return "unknown"
  }
}
const MAX_ACTION = 128
const MAX_METADATA_ENTRIES = 32
const MAX_METADATA_VALUE = 4_096

const cycle = new Runtime()

/**
 * Section 11: the chain is verified when the control plane starts, not only when somebody
 * thinks to ask. It reports rather than refuses — a project whose history was altered still
 * needs its state readable, and an append-only record that can be repaired is not one.
 */
const startupIntegrity = ((): string | null => {
  const database = cycle.store()
  if (database === undefined) return null

  const chain = verifyHistory(database)
  if (!chain.valid) {
    return `the project history does not verify at sequence ${chain.sequence} (${chain.reason})`
  }
  const signatures = verifyCheckpoints(database)
  if (!signatures.valid) {
    return `the signed checkpoint at sequence ${signatures.sequence} does not verify (${signatures.reason})`
  }
  return null
})()

const doctor: ToolDefinition = {
  description:
    "Report the Cycle installation state: runtime, storage, store schema, per-role model " +
    "assignments and any condition that would silently change how the workflow runs. Read-only.",
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  name: "doctor",
  async run() {
    const report = await diagnose(cycle, VERSION)
    return { report, summary: renderDoctor(report) }
  },
}

const roleSettings: ToolDefinition = {
  description:
    "Resolve the Antigravity custom-agent name and model tier configured for one advisory role. " +
    "Returns data only; the calling skill invokes the named role with invoke_subagent.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      consultation: { enum: Object.keys(CONSULTATION), type: "string" },
    },
    required: ["consultation"],
    type: "object",
  },
  name: "role_settings",
  run(args) {
    const resolved = resolveConsultation(cycle.configuration, String(args["consultation"]))
    return {
      advisory: true,
      agent: resolved.agent,
      effort: resolved.effort,
      // No imperative field here, deliberately. This is tool output, and tool output is data: a
      // sentence telling the caller to invoke something is indistinguishable from an injection
      // riding in a tool result, and an agent that guards against that refuses it — along with the
      // legitimate model beside it, silently falling back to the session default. The skill holds
      // the instruction; this returns what the instruction needs.
      inherits: resolved.inherits,
      model: resolved.model,
      // Antigravity accepts the native inherit, flash and pro tiers. Null means inherit.
      subagentModel: resolved.subagentModel,
      projectId: cycle.project.id,
      role: resolved.role,
      warning: null,
    }
  },
}

/**
 * What the caller needs before it spends a workflow on this role: an override that will silently
 * replace the model, and a model the session has no way to reach. Both make the returned
 * assignment untrue at the moment it is used.
 */
const permissions: ToolDefinition = {
  description:
    "The immutable boundaries between the Cycle roles: what each may do, what it is denied, and " +
    "which of them may modify files. Not configurable and not advisory — the same table the " +
    "agents declare and the PreToolUse guard enforces. Read-only.",
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  name: "permissions",
  run() {
    return {
      boundaries: BOUNDARIES,
      enforcement: [
        "declaration: each Antigravity custom agent exposes only the tools its role needs",
        "runtime: a PreToolUse hook forces explicit approval for history-changing, publishing, " +
          "and recursive deletion commands",
        "reconciliation: after each executor task the control plane reads the worktree itself and " +
          "rejects the task if any changed path falls outside the write scopes the plan authorized",
      ],
      invariant:
        "Approval and delivery exist only inside a governed cycle with recorded evidence. No role " +
        "approves its own work, and no configuration changes that.",
    }
  },
}

const recordEvent: ToolDefinition = {
  description:
    "Append one action to the tamper-evident project history. Records who did what and when. " +
    "Entries cannot be edited or deleted afterwards.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      action: { maxLength: MAX_ACTION, minLength: 1, type: "string" },
      metadata: { additionalProperties: { type: "string" }, type: "object" },
      role: { enum: [...ROLES], type: "string" },
      sessionId: { maxLength: 256, type: "string" },
    },
    required: ["action"],
    type: "object",
  },
  name: "record_event",
  run(args) {
    const database = cycle.requireStore()
    const entry = appendHistory(
      database,
      {
        action: boundedAction(args["action"]),
        actor: "cycle",
        metadata: boundedMetadata(args["metadata"]),
        projectId: cycle.project.id,
        role: (args["role"] as Role | undefined) ?? null,
        sessionId: typeof args["sessionId"] === "string" ? args["sessionId"] : null,
      },
      Date.now(),
    )
    return { hash: entry.hash, sequence: entry.sequence }
  },
}

function boundedAction(value: unknown): string {
  const action = String(value ?? "").trim()
  if (!action || action.length > MAX_ACTION || !/^[a-z][a-z0-9_.:-]*$/u.test(action)) {
    throw new Error("action must be a short lowercase identifier such as consultation.architect")
  }
  return action
}

function boundedMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_METADATA_ENTRIES)
      .map(([key, entry]) => [key.slice(0, 64), String(entry).slice(0, MAX_METADATA_VALUE)]),
  )
}

const indexTool: ToolDefinition = {
  description:
    "Build or refresh the project's code graph. Incremental: a file whose bytes have not changed " +
    "is never reparsed. Safe to call repeatedly.",
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  name: "index_project",
  async run() {
    const database = cycle.requireStore()
    const started = Date.now()
    // Indexing is background work and verification is not: a candidate waiting on gates gets the
    // machine, and the index continues from where it stopped on the next call.
    const report = await indexProject(database, cycle.project.id, cycle.project.path, {
      shouldYield: () => verificationPending(database, cycle.project.id),
    })
    return { ...report, durationMs: Date.now() - started, project: cycle.project.path }
  },
}

const graphTool: ToolDefinition = {
  description:
    "Query the code graph without loading the repository. `symbol` finds a definition by name, " +
    "`neighbours` walks its edges, `impact` reports what a change to given files can reach, " +
    "`scope` returns a budgeted context slice, `status` reports graph size.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      budgetBytes: { maximum: 1_000_000, minimum: 1_000, type: "number" },
      depth: { maximum: 4, minimum: 1, type: "number" },
      name: { maxLength: 256, type: "string" },
      operation: { enum: ["symbol", "neighbours", "impact", "scope", "status"], type: "string" },
      paths: { items: { type: "string" }, maxItems: 200, type: "array" },
    },
    required: ["operation"],
    type: "object",
  },
  name: "graph_query",
  run(args) {
    const database = cycle.requireStore()
    const project = cycle.project.id
    const paths = Array.isArray(args["paths"]) ? (args["paths"] as string[]) : []
    const depth = typeof args["depth"] === "number" ? args["depth"] : 2

    switch (args["operation"]) {
      case "status":
        return graphSize(database, project)
      case "symbol":
        return { nodes: findSymbol(database, project, requireName(args)) }
      case "neighbours": {
        const [node] = findSymbol(database, project, requireName(args))
        if (node === undefined) return { edges: [], found: false }
        return { edges: neighboursOf(database, node.id, depth).edges, found: true, node }
      }
      case "impact":
        return { nodes: impactOf(database, project, requirePaths(paths), depth) }
      case "scope":
        return scopeBundle(
          database,
          project,
          requirePaths(paths),
          typeof args["budgetBytes"] === "number" ? args["budgetBytes"] : undefined,
        )
      default:
        throw new Error("unknown graph operation")
    }
  },
}

function requireName(args: Record<string, unknown>): string {
  const name = args["name"]
  if (typeof name !== "string" || !name.trim()) throw new Error("this operation requires name")
  return name
}

function requirePaths(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new Error("this operation requires at least one path")
  return [...paths]
}

const WORKFLOW_OPERATIONS = [
  "export",
  "start",
  "status",
  "evidence",
  "submit_plan",
  "report_task",
  "freeze_candidate",
  "verify",
  "submit_review",
  "submit_browser_evidence",
  "run_proof",
  "arbitrate",
  "deliver",
  "reconcile",
  "history",
  "recall",
  "control",
] as const


const MEMORY_OPERATIONS = ["search", "explain", "chain", "forget"] as const

const memoryTool: ToolDefinition = {
  description:
    "Project knowledge derived from completed work and linked to the evidence that justifies it. " +
    "`search` returns a compact index — identifier, kind, confidence, title, scope — cheap enough " +
    "to list many; `explain` fetches full detail for the few identifiers worth reading. `chain` " +
    "walks the supersession history of one entry. `forget` revokes an entry and needs confirm: " +
    "true; nothing is ever deleted.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      confirm: { type: "boolean" },
      ids: { items: { type: "string" }, maxItems: 20, type: "array" },
      limit: { maximum: 50, minimum: 1, type: "number" },
      memoryId: { maxLength: 64, type: "string" },
      operation: { enum: [...MEMORY_OPERATIONS], type: "string" },
      paths: { items: { type: "string" }, maxItems: 200, type: "array" },
      query: { maxLength: 4_096, type: "string" },
    },
    required: ["operation"],
    type: "object",
  },
  name: "memory",
  run(args) {
    const context = {
      database: cycle.requireStore(),
      projectId: cycle.project.id,
    }
    const identifier = () => {
      const value = args["memoryId"]
      if (typeof value !== "string" || !value) throw new Error("this operation requires memoryId")
      return value
    }

    switch (args["operation"]) {
      case "search":
        return {
          memories: recall(
            context,
            String(args["query"] ?? ""),
            Array.isArray(args["paths"]) ? (args["paths"] as string[]) : [],
            typeof args["limit"] === "number" ? args["limit"] : undefined,
          ),
        }
      case "explain":
        return {
          memories: explain(
            context,
            Array.isArray(args["ids"]) ? (args["ids"] as string[]) : [],
          ),
        }
      case "chain":
        return { chain: chainOf(context, identifier()) }
      case "forget": {
        // Revocation is not automatic and never implied: the caller says so explicitly.
        if (args["confirm"] !== true) {
          throw new Error("forgetting a memory requires confirm: true")
        }
        return forget(context, identifier())
      }
      default:
        throw new Error("unknown memory operation")
    }
  },
}


const GOAL_OPERATIONS = [
  "new",
  "list",
  "focus",
  "plan",
  "link",
  "amend",
  "status",
  "advance",
  "extend",
  "pause",
  "resume",
  "complete",
  "approve",
  "abort",
] as const

const goalTool: ToolDefinition = {
  description:
    "A persistent objective above individual workflows. The objective is immutable once created; " +
    "clarifications are appended as amendments. Each milestone is an ordinary evidence-gated " +
    "workflow, and a goal cannot complete while any of them is incomplete. `complete` requests " +
    "completion; `approve` needs confirm: true and is the only thing that completes a goal.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      additional: { maximum: 50, minimum: 1, type: "number" },
      clarification: { maxLength: 8_192, type: "string" },
      confirm: { type: "boolean" },
      constraints: { items: { type: "string" }, maxItems: 50, type: "array" },
      content: { maxLength: 8_192, type: "string" },
      goalId: { maxLength: 64, type: "string" },
      maxContinuations: { maximum: 50, minimum: 1, type: "number" },
      milestone: { maxLength: 200, type: "string" },
      nonGoals: { items: { type: "string" }, maxItems: 50, type: "array" },
      objective: { maxLength: 8_192, type: "string" },
      operation: { enum: [...GOAL_OPERATIONS], type: "string" },
      successCriteria: { items: { type: "string" }, maxItems: 50, type: "array" },
      workflowId: { maxLength: 64, type: "string" },
    },
    required: ["operation"],
    type: "object",
  },
  name: "goal",
  run(args) {
    const context = { database: cycle.requireStore(), projectId: cycle.project.id }
    const strings = (key: string): string[] =>
      Array.isArray(args[key]) ? (args[key] as string[]) : []
    const identifier = () => {
      const value = args["goalId"]
      if (typeof value !== "string" || !value) throw new Error("this operation requires goalId")
      return value
    }

    switch (args["operation"]) {
      case "new":
        return newGoal(context, {
          constraints: strings("constraints"),
          nonGoals: strings("nonGoals"),
          objective: String(args["objective"] ?? ""),
          successCriteria: strings("successCriteria"),
          ...(typeof args["maxContinuations"] === "number"
            ? { maxContinuations: args["maxContinuations"] }
            : {}),
        })
      case "list":
        return goals(context)
      case "focus":
        return focusGoalById(context, identifier())
      case "plan":
        return typeof args["content"] === "string" && args["content"].trim()
          ? planGoal(context, identifier(), args["content"])
          : currentPlan(context, identifier())
      case "link":
        return link(
          context,
          identifier(),
          String(args["milestone"] ?? ""),
          typeof args["workflowId"] === "string" && args["workflowId"] ? args["workflowId"] : null,
        )
      case "amend":
        return amend(context, identifier(), String(args["clarification"] ?? ""))
      case "status":
        return goalStatus(context, typeof args["goalId"] === "string" ? args["goalId"] : undefined)
      case "advance":
        return advance(context, identifier())
      case "extend":
        return extend(
          context,
          identifier(),
          typeof args["additional"] === "number" ? args["additional"] : 1,
        )
      case "pause":
        return pauseGoal(context, identifier())
      case "resume":
        return resumeGoal(context, identifier())
      case "complete":
        return requestCompletion(context, identifier())
      case "approve":
        return approveCompletion(context, identifier(), args["confirm"] === true)
      case "abort":
        return abort(context, identifier(), args["confirm"] === true)
      default:
        throw new Error("unknown goal operation")
    }
  },
}


const limitsTool: ToolDefinition = {
  description:
    "Admission and resource governance. `status` reports the reserves, what the machine has right " +
    "now, the active leases and this project's share of them. `admit` requests a slot for a " +
    "workflow and is deferred with a reason rather than blocked; `renew` extends a held lease; " +
    "`release` gives the slot back. A lease that is not renewed expires on its own.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      operation: { enum: ["status", "admit", "renew", "release"], type: "string" },
      workflowId: { maxLength: 64, type: "string" },
    },
    required: ["operation"],
    type: "object",
  },
  name: "limits",
  async run(args) {
    const database = cycle.requireStore()
    const identifier = () => {
      const value = args["workflowId"]
      if (typeof value !== "string" || !value) throw new Error("this operation requires workflowId")
      return value
    }

    switch (args["operation"]) {
      case "status":
        return cycle.admission.report(database, cycle.project.id, await cycle.resources())
      case "admit": {
        // A slot is leased to a registered workflow. Refusing an unknown one here says so plainly,
        // rather than letting a foreign key failure answer for the control plane.
        const workflowId = identifier()
        const owner = database.get<{ project_id: string }>(
          "select project_id from workflows where id = ?",
          workflowId,
        )
        if (owner === undefined) throw new Error(`unknown workflow: ${workflowId}`)
        if (owner.project_id !== cycle.project.id) {
          throw new Error("that workflow belongs to another project")
        }
        return cycle.admission.request(
          database,
          cycle.project.id,
          workflowId,
          await cycle.resources(),
        )
      }
      case "renew":
        return cycle.admission.renew(database, identifier())
      case "release": {
        release(database, identifier())
        return { released: true }
      }
      default:
        throw new Error("unknown limits operation")
    }
  },
}

const workflowTool: ToolDefinition = {
  description:
    "Drive one governed Cycle workflow. The state machine decides what is allowed next; an " +
    "operation sent in the wrong state is refused rather than reordered. `submit_browser_evidence` " +
    "records a captured user flow and its accessibility tree. A reviewer proves the interface " +
    "layer by spending the `captureToken` it was issued when the candidate was frozen; a " +
    "submission without one is recorded as a self-report and carries no weight. " +
    "`run_proof` executes one security proof against a disposable copy of the candidate: supply " +
    "the proof source as `script` and write it so exit code 0 means the vulnerability was shown. " +
    "`deliver` promotes the approved bytes and re-verifies them; `reconcile` resumes a workflow " +
    "after the application restarted; `history` reads the chain and verifies its signatures. " +
    "`control` carries an optional `reason` that classifies why it was issued — a provider that " +
    "stopped answering is not the same event as a user pausing — and the classification is kept " +
    "in the chain and reported by `status` and `reconcile`.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      affectedPaths: { items: { type: "string" }, maxItems: 500, type: "array" },
      after: { minimum: 0, type: "number" },
      limit: { maximum: 500, minimum: 1, type: "number" },
      confirm: { type: "boolean" },
      controlOperation: { enum: ["pause", "resume", "repair", "cancel", "retry"], type: "string" },
      kind: { enum: ["state", "history", "evidence"], type: "string" },
      operation: { enum: [...WORKFLOW_OPERATIONS], type: "string" },
      command: { maxLength: 4_096, type: "string" },
      plan: { type: "object" },
      preference: { enum: ["auto", "quick", "full"], type: "string" },
      interpreter: { maxLength: 32, type: "string" },
      rationale: { maxLength: 2_048, type: "string" },
      reason: { maxLength: 512, type: "string" },
      script: { maxLength: 65_536, type: "string" },
      captureToken: { maxLength: 128, type: "string" },
      snapshot: { type: "object" },
      request: { maxLength: 100_000, type: "string" },
      role: { enum: ["functional_reviewer", "security_reviewer"], type: "string" },
      status: { enum: ["completed", "blocked", "plan_defect"], type: "string" },
      summary: { maxLength: 4_096, type: "string" },
      taskKey: { maxLength: 64, type: "string" },
      verdict: { type: "object" },
      vulnerabilityClass: { maxLength: 64, type: "string" },
      workflowId: { maxLength: 64, type: "string" },
    },
    required: ["operation"],
    type: "object",
  },
  name: "workflow",
  async run(args) {
    const context: ServiceContext = {
      configuration: cycle.configuration,
      database: cycle.requireStore(),
      dataDirectory: cycle.dataDirectory,
      maxRepairCycles: cycle.configuration.maxRepairCycles,
      projectId: cycle.project.id,
    }
    // Surfaced on every workflow answer while it is true, because a caller acting on state
    // whose record has been altered should never learn that from a separate command.
    const flag = startupIntegrity === null ? {} : { historyAltered: startupIntegrity }
    const id = () => {
      const value = args["workflowId"]
      if (typeof value !== "string" || !value) throw new Error("this operation requires workflowId")
      return value
    }

    switch (args["operation"]) {
      case "start":
        return withFlag(flag, startWorkflow(
          context,
          String(args["request"] ?? ""),
          Array.isArray(args["affectedPaths"]) ? (args["affectedPaths"] as string[]) : [],
          (args["preference"] as "auto" | "full" | "quick" | undefined) ?? "auto",
        ))
      case "status":
        return withFlag(
          flag,
          workflowStatus(context, typeof args["workflowId"] === "string" ? args["workflowId"] : undefined),
        )
      case "evidence":
        return candidateEvidence(context, id())
      case "submit_plan":
        return submitPlan(context, id(), args["plan"])
      case "report_task": {
        // Layer three reconciles against the worktree, not against the executor's summary, so the
        // change set is read here rather than taken from the caller.
        // changedFiles returns null when the change set cannot be determined; that null is passed
        // through, because only the layer that knows the scope rule may decide what unknown means.
        const read = args["status"] === "completed" ? await changedFiles(cycle.project.path) : []
        const changed = read === null ? null : read.map((file) => file.path)
        return reportTask(
          context,
          id(),
          String(args["taskKey"] ?? ""),
          (args["status"] as "blocked" | "completed" | "plan_defect") ?? "completed",
          String(args["summary"] ?? ""),
          changed,
        )
      }
      case "freeze_candidate":
        // Refuses outright when the repository has no base revision or is mid-merge: a candidate
        // nobody can describe is never frozen into one that looks describable.
        return freezeCandidate(context, id(), await captureCandidate(cycle.project.path))
      case "verify": {
        const workflowId = id()
        const inputs = verificationInputs(context, workflowId)
        const outcome = await verify({
          candidateId: inputs.candidateId,
          database: context.database,
          projectId: cycle.project.id,
          root: cycle.project.path,
          strictness: cycle.configuration.gateStrictness,
          taskCommands: inputs.taskCommands,
        })
        return verifyCandidate(context, workflowId, outcome)
      }
      case "submit_review":
        return submitReviewVerdict(
          context,
          id(),
          (args["role"] as "functional_reviewer" | "security_reviewer") ?? "functional_reviewer",
          args["verdict"],
        )
      case "submit_browser_evidence": {
        // The role is never taken from the caller: it is read from the capability the caller spends.
        // A caller with no capability is recording its own report of its own work.
        const token = typeof args["captureToken"] === "string" ? args["captureToken"] : null
        return submitBrowserEvidence(context, id(), args["snapshot"], token)
      }
      case "run_proof":
        return await submitSecurityProof(context, id(), cycle.project.path, {
          ...(typeof args["command"] === "string" ? { command: args["command"] } : {}),
          ...(typeof args["interpreter"] === "string"
            ? { interpreter: args["interpreter"] }
            : {}),
          ...(typeof args["script"] === "string" ? { script: args["script"] } : {}),
          rationale: String(args["rationale"] ?? ""),
          vulnerabilityClass: String(args["vulnerabilityClass"] ?? ""),
        })
      case "arbitrate":
        return arbitrate(context, id(), args["verdict"], mandatoryGatesPassed(context, id()))
      case "deliver":
        return await deliverCandidate(context, id(), cycle.project.path)
      case "reconcile":
        return await reconcile(
          context,
          cycle.project.path,
          typeof args["workflowId"] === "string" ? args["workflowId"] : undefined,
        )
      case "recall":
        return recallForRequest(
          context,
          String(args["request"] ?? ""),
          Array.isArray(args["affectedPaths"]) ? (args["affectedPaths"] as string[]) : [],
        )
      case "history":
        return historyState(
          context,
          typeof args["limit"] === "number" ? args["limit"] : 50,
          typeof args["after"] === "number" ? args["after"] : undefined,
        )
      case "control": {
        const operation =
          (args["controlOperation"] as "cancel" | "pause" | "repair" | "resume" | "retry") ?? "pause"
        // Cancelling throws away authorized work in progress. It is never implied.
        if (operation === "cancel" && args["confirm"] !== true) {
          throw new Error("cancelling a workflow requires confirm: true")
        }
        return control(
          context,
          id(),
          operation,
          typeof args["reason"] === "string" ? args["reason"] : undefined,
        )
      }
      case "export": {
        if (args["confirm"] !== true) {
          throw new Error("exporting requires confirm: true")
        }
        return exportState(
          context,
          (args["kind"] as "evidence" | "history" | "state") ?? "state",
          typeof args["workflowId"] === "string" ? args["workflowId"] : undefined,
        )
      }
      default:
        throw new Error("unknown workflow operation")
    }
  },
}

function withFlag(flag: Record<string, string>, result: unknown): unknown {
  if (Object.keys(flag).length === 0) return result
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result
  return { ...(result as Record<string, unknown>), ...flag }
}

function verificationPending(database: ReturnType<typeof cycle.requireStore>, projectId: string): boolean {
  const row = database.get<{ total: number }>(
    "select count(*) as total from workflows where project_id = ? and state = 'verification'",
    projectId,
  )
  return Number(row?.total ?? 0) > 0
}

process.on("exit", () => cycle.close())

serve({ name: "cycle-control-plane", version: VERSION }, [
  doctor,
  roleSettings,
  permissions,
  recordEvent,
  indexTool,
  graphTool,
  goalTool,
  limitsTool,
  memoryTool,
  workflowTool,
])
