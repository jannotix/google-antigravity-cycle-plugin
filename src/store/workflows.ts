import type {
  CandidateFileEntry,
  CandidateManifest,
  CapturedCandidate,
} from "../evidence/candidate.ts"
import type { Plan } from "../workflow/plan.ts"
import type { Workflow, WorkflowMode, WorkflowState } from "../workflow/machine.ts"
import type { Verdict } from "../workflow/verdicts.ts"
import type { Database, Row } from "./database.ts"
import { DIGEST_DOMAIN, digest, newId } from "./ids.ts"

export interface StoredRequest {
  readonly amendments: readonly { receivedAt: number; sequence: number; text: string }[]
  readonly digest: string
  readonly originalText: string
}

export interface StoredWorkflow extends Workflow {
  readonly createdAt: number
  readonly id: string
  readonly projectId: string
  readonly updatedAt: number
}

export function createWorkflow(
  database: Database,
  projectId: string,
  originalText: string,
  maxRepairCycles: number,
  now: number,
): { id: string; requestDigest: string } {
  const id = newId()
  const requestDigest = digest(DIGEST_DOMAIN.request, { attachments: [], text: originalText })

  database.transaction(() => {
    database.run(
      `insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at)
       values (?, ?, 'intake', ?, ?, ?)`,
      id,
      projectId,
      maxRepairCycles,
      now,
      now,
    )
    database.run(
      "insert into requests (workflow_id, original_text, digest, created_at) values (?, ?, ?, ?)",
      id,
      originalText,
      requestDigest,
      now,
    )
  })

  return { id, requestDigest }
}

/** The digest a request will be stored under, so a caller can look one up before creating it. */
export function requestDigestOf(originalText: string): string {
  return digest(DIGEST_DOMAIN.request, { attachments: [], text: originalText })
}

/**
 * A workflow already running for this exact request. `start` is relayed through an agent, and a
 * relay that loses the response will send it again: without this the second call mints a second
 * workflow, and the run silently forks. Terminal workflows are excluded so the same request can be
 * run again deliberately once the first one is finished.
 */
export function activeWorkflowForRequest(
  database: Database,
  projectId: string,
  requestDigest: string,
): StoredWorkflow | undefined {
  const row = database.get<Row>(
    `select workflows.* from workflows
       join requests on requests.workflow_id = workflows.id
      where workflows.project_id = ?
        and requests.digest = ?
        and workflows.state not in ('cancelled', 'completed')
      order by workflows.created_at desc
      limit 1`,
    projectId,
    requestDigest,
  )
  return row === undefined ? undefined : toWorkflow(row)
}

export function loadWorkflow(database: Database, id: string): StoredWorkflow | undefined {
  const row = database.get<Row>("select * from workflows where id = ?", id)
  return row === undefined ? undefined : toWorkflow(row)
}

export function latestWorkflow(database: Database, projectId: string): StoredWorkflow | undefined {
  const row = database.get<Row>(
    "select * from workflows where project_id = ? order by updated_at desc limit 1",
    projectId,
  )
  return row === undefined ? undefined : toWorkflow(row)
}

export function saveWorkflow(database: Database, workflow: StoredWorkflow, now: number): void {
  database.run(
    `update workflows set state = ?, mode = ?, candidate_id = ?, repair_target = ?,
       repair_cycles = ?, max_repair_cycles = ?, paused_from = ?, blocked_from = ?, updated_at = ?
     where id = ?`,
    workflow.state,
    workflow.mode,
    workflow.candidateId,
    workflow.repairTarget,
    workflow.repairCycles,
    workflow.maxRepairCycles,
    workflow.pausedFrom,
    workflow.blockedFrom,
    now,
    workflow.id,
  )
}

export function loadRequest(database: Database, workflowId: string): StoredRequest | undefined {
  const row = database.get<Row>("select * from requests where workflow_id = ?", workflowId)
  if (row === undefined) return undefined
  return {
    amendments: JSON.parse(String(row["amendments"])) as StoredRequest["amendments"],
    digest: String(row["digest"]),
    originalText: String(row["original_text"]),
  }
}

/** The objective never changes; a clarification is appended with the next sequence number. */
export function amendRequest(
  database: Database,
  workflowId: string,
  text: string,
  now: number,
): void {
  const current = loadRequest(database, workflowId)
  if (current === undefined) throw new Error("no request for this workflow")

  const amendments = [
    ...current.amendments,
    { receivedAt: now, sequence: current.amendments.length + 1, text },
  ]
  database.run(
    "update requests set amendments = ? where workflow_id = ?",
    JSON.stringify(amendments),
    workflowId,
  )
}

export function savePlan(database: Database, workflowId: string, plan: Plan, now: number): void {
  database.transaction(() => {
    database.run("delete from tasks where workflow_id = ?", workflowId)
    plan.tasks.forEach((task, position) => {
      database.run(
        `insert into tasks (
           id, workflow_id, task_key, title, objective, state, position,
           write_scopes, dependencies, requirement_ids, acceptance_criteria,
           verification_commands, created_at, updated_at
         ) values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        workflowId,
        task.key,
        task.title,
        task.objective,
        position,
        JSON.stringify(task.writeScopes),
        JSON.stringify(task.dependencies),
        JSON.stringify(task.requirementIds),
        JSON.stringify(task.acceptanceCriteria),
        JSON.stringify(task.verificationCommands),
        now,
        now,
      )
    })
    database.run(
      "update workflows set plan_json = ?, updated_at = ? where id = ?",
      JSON.stringify(plan),
      now,
      workflowId,
    )
  })
}

export function loadPlan(database: Database, workflowId: string): Plan | undefined {
  const row = database.get<Row>("select plan_json from workflows where id = ?", workflowId)
  const raw = String(row?.["plan_json"] ?? "")
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Plan
  } catch {
    return undefined
  }
}

export interface StoredTask {
  readonly id: string
  readonly key: string
  readonly objective: string
  readonly position: number
  readonly state: string
  readonly title: string
  readonly verificationCommands: readonly string[]
  readonly writeScopes: readonly string[]
}

export function loadTasks(database: Database, workflowId: string): StoredTask[] {
  return database
    .all<Row>("select * from tasks where workflow_id = ? order by position", workflowId)
    .map((row) => ({
      id: String(row["id"]),
      key: String(row["task_key"]),
      objective: String(row["objective"]),
      position: Number(row["position"]),
      state: String(row["state"]),
      title: String(row["title"]),
      verificationCommands: JSON.parse(String(row["verification_commands"])) as string[],
      writeScopes: JSON.parse(String(row["write_scopes"])) as string[],
    }))
}

export function setTaskState(
  database: Database,
  workflowId: string,
  key: string,
  state: string,
  now: number,
): void {
  database.run(
    "update tasks set state = ?, updated_at = ? where workflow_id = ? and task_key = ?",
    state,
    now,
    workflowId,
    key,
  )
}

export type CandidateFile = CandidateFileEntry

/**
 * Freezing records what the candidate is: the commit it sits on, every changed path with the digest
 * of its bytes at this moment, and those bytes themselves where they fit. The integrity gate
 * re-reads the same paths before the gates run and delivery re-reads them again, so a file that
 * moves at any point after the freeze is caught rather than carried along.
 */
export function recordCandidate(
  database: Database,
  workflowId: string,
  candidateId: string,
  captured: CapturedCandidate,
  now: number,
): string {
  const { manifest, payloads } = captured

  database.transaction(() => {
    database.run(
      `insert into candidates (id, workflow_id, base_revision, manifest, diff_digest, candidate_digest, frozen_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      candidateId,
      workflowId,
      manifest.baseRevision,
      JSON.stringify(manifest),
      manifest.diffDigest,
      manifest.candidateDigest,
      now,
    )
    for (const file of manifest.files) {
      database.run(
        "insert into candidate_files (candidate_id, path, kind, digest, payload) values (?, ?, ?, ?, ?)",
        candidateId,
        file.path,
        file.kind,
        file.digest,
        payloads.get(file.path) ?? null,
      )
    }
  })

  return manifest.candidateDigest
}

export function candidateManifest(
  database: Database,
  candidateId: string,
): CandidateManifest | undefined {
  const row = database.get<Row>("select manifest from candidates where id = ?", candidateId)
  if (row === undefined) return undefined
  try {
    return JSON.parse(String(row["manifest"])) as CandidateManifest
  } catch {
    return undefined
  }
}

export function frozenFiles(database: Database, candidateId: string): CandidateFile[] {
  return database
    .all<Row>(
      "select path, kind, digest from candidate_files where candidate_id = ? order by path",
      candidateId,
    )
    .map((row) => ({
      digest: (row["digest"] as string | null) ?? null,
      kind: String(row["kind"]),
      path: String(row["path"]),
    }))
}

export function submitReview(
  database: Database,
  workflowId: string,
  candidateId: string,
  role: string,
  verdict: Verdict,
  now: number,
): { reviewsReady: boolean } {
  database.run(
    `insert into reviews (id, workflow_id, candidate_id, role, verdict, verdict_digest, submitted_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict (candidate_id, role) do update set
       verdict = excluded.verdict, verdict_digest = excluded.verdict_digest,
       submitted_at = excluded.submitted_at`,
    newId(),
    workflowId,
    candidateId,
    role,
    JSON.stringify(verdict),
    digest(DIGEST_DOMAIN.verdict, verdict),
    now,
  )

  const count = database.get<{ total: number }>(
    "select count(*) as total from reviews where candidate_id = ?",
    candidateId,
  )
  return { reviewsReady: (count?.total ?? 0) >= 2 }
}

export function loadReviews(
  database: Database,
  candidateId: string,
): { role: string; verdict: Verdict }[] {
  return database
    .all<Row>("select role, verdict from reviews where candidate_id = ? order by role", candidateId)
    .map((row) => ({
      role: String(row["role"]),
      verdict: JSON.parse(String(row["verdict"])) as Verdict,
    }))
}

/**
 * What the last refusal actually said, so the role about to repair is told rather than left to
 * rediscover it. Keyed by workflow rather than by candidate, because `begin_repair` clears the
 * candidate: the findings belong to the candidate that was refused, and the repair happens after it
 * is gone. Reviews that approved are omitted — an approval names nothing to fix.
 */
export function lastRefusal(
  database: Database,
  workflowId: string,
): { findings: readonly unknown[]; from: string }[] {
  const arbitration = database.get<Row>(
    `select candidate_id, verdict from arbitrations
      where workflow_id = ? and decision = 'rejected'
      order by finalized_at desc limit 1`,
    workflowId,
  )
  if (arbitration === undefined) return []

  const candidateId = String(arbitration["candidate_id"])
  const refusals: { findings: readonly unknown[]; from: string }[] = []
  for (const review of loadReviews(database, candidateId)) {
    if (review.verdict.decision !== "rejected") continue
    refusals.push({ findings: review.verdict.findings ?? [], from: review.role })
  }

  const verdict = JSON.parse(String(arbitration["verdict"])) as Verdict
  refusals.push({ findings: verdict.findings ?? [], from: "arbiter" })
  return refusals.filter((refusal) => refusal.findings.length > 0)
}

export function recordArbitration(
  database: Database,
  workflowId: string,
  candidateId: string,
  verdict: Verdict,
  now: number,
): string {
  const receiptDigest = digest(DIGEST_DOMAIN.verdict, { candidateId, verdict, workflowId })
  database.run(
    `insert into arbitrations (
       id, workflow_id, candidate_id, decision, verdict, receipt, receipt_digest, finalized_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (candidate_id) do update set
       decision = excluded.decision, verdict = excluded.verdict,
       receipt = excluded.receipt, receipt_digest = excluded.receipt_digest,
       finalized_at = excluded.finalized_at`,
    newId(),
    workflowId,
    candidateId,
    verdict.decision,
    JSON.stringify(verdict),
    JSON.stringify({ candidateId, decision: verdict.decision, workflowId }),
    receiptDigest,
    now,
  )
  return receiptDigest
}

function toWorkflow(row: Row): StoredWorkflow {
  return {
    blockedFrom: (row["blocked_from"] as WorkflowState | null) ?? null,
    candidateId: (row["candidate_id"] as string | null) ?? null,
    createdAt: Number(row["created_at"]),
    id: String(row["id"]),
    maxRepairCycles: Number(row["max_repair_cycles"]),
    mode: (row["mode"] as WorkflowMode | null) ?? null,
    pausedFrom: (row["paused_from"] as WorkflowState | null) ?? null,
    projectId: String(row["project_id"]),
    repairCycles: Number(row["repair_cycles"]),
    repairTarget: (row["repair_target"] as StoredWorkflow["repairTarget"]) ?? null,
    state: String(row["state"]) as WorkflowState,
    updatedAt: Number(row["updated_at"]),
  }
}
