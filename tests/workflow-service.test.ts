import { readConfiguration } from "../src/config.ts"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import type { CapturedCandidate } from "../src/evidence/candidate.ts"

import { Database } from "../src/store/database.ts"
import { newId } from "../src/store/ids.ts"
import { loadWorkflow } from "../src/store/workflows.ts"
import {
  arbitrate,
  candidateEvidence,
  control,
  freezeCandidate,
  historyState,
  mandatoryGatesPassed,
  reconcile,
  reportTask,
  startWorkflow,
  submitPlan,
  submitBrowserEvidence,
  submitReviewVerdict,
  submitSecurityProof,
  verifyCandidate,
  workflowStatus,
  WorkflowError,
  type ServiceContext,
} from "../src/workflow/service.ts"
import { VerdictRejected } from "../src/workflow/verdicts.ts"

const PLAN = {
  assumptions: [],
  integration_checks: ["the endpoint is reachable"],
  requirements: [{ acceptance_criteria: ["returns 200"], id: "REQ-1", statement: "expose health" }],
  risks: [],
  tasks: [
    {
      acceptance_criteria: ["returns 200"],
      dependencies: [],
      key: "task-1",
      objective: "add the endpoint",
      requirement_ids: ["REQ-1"],
      title: "Health endpoint",
      verification_commands: ["npm test"],
      write_scopes: ["src/health"],
    },
  ],
}

const APPROVAL = {
  decision: "approved",
  findings: [],
  repair_target: null,
  requirements: [{ evidence_ids: [], requirement_id: "REQ-1", status: "satisfied" }],
}

const REJECTION = {
  decision: "rejected",
  findings: [{ evidence_ids: [], severity: "high", summary: "no test covers the flow" }],
  repair_target: "execution",
  requirements: [{ evidence_ids: [], requirement_id: "REQ-1", status: "unsatisfied" }],
}

/** A candidate with no files: enough to freeze, and nothing for delivery to write. */
export function emptyCandidate(): CapturedCandidate {
  return {
    manifest: {
      baseRevision: "0".repeat(40),
      candidateDigest: "d",
      configurationDigest: "c",
      dependencyStateDigest: "p",
      diffDigest: "f",
      environmentDigest: "e",
      evidenceIds: [],
      files: [],
    },
    payloads: new Map(),
  }
}

function context(): { close: () => void; ctx: ServiceContext } {
  const database = new Database({ path: ":memory:" })
  const directory = mkdtempSync(join(tmpdir(), "cycle-service-"))
  return {
    close: () => {
      database.close()
      rmSync(directory, { force: true, recursive: true })
    },
    ctx: { configuration: readConfiguration({}), database, dataDirectory: directory, maxRepairCycles: 5, projectId: "p1" },
  }
}

const state = (value: unknown): string => (value as { state: string }).state

/** Drives a workflow to arbitration with verification reported as passing. */
function toArbitration(ctx: ServiceContext, reviews: unknown[] = [APPROVAL, APPROVAL]): string {
  const started = startWorkflow(ctx, "add oauth login to the dashboard", ["src/auth.ts"], "full") as {
    workflowId: string
  }
  const id = started.workflowId

  submitPlan(ctx, id, PLAN)
  reportTask(ctx, id, "task-1", "completed", "done")
  freezeCandidate(ctx, id, emptyCandidate())
  verifyCandidate(ctx, id, { evidenceIds: ["e1"], mandatoryPassed: true, reason: "gates passed" })

  submitReviewVerdict(ctx, id, "functional_reviewer", reviews[0])
  submitReviewVerdict(ctx, id, "security_reviewer", reviews[1])
  return id
}

test("starting a workflow routes it and records the exact request", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add oauth login", ["src/auth.ts"], "auto") as {
      mode: string
      requestDigest: string
      state: string
    }

    assert.equal(started.mode, "full")
    assert.equal(started.state, "architecture")
    assert.match(started.requestDigest, /^[0-9a-f]{64}$/u)
  } finally {
    close()
  }
})

// Certification 3.2, 4.1.
test("a localised change routes to the quick path and skips architecture", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "auto") as {
      mode: string
      state: string
    }

    assert.equal(started.mode, "quick")
    assert.equal(started.state, "quick_execution")
  } finally {
    close()
  }
})

/**
 * Found by a real run: the operator relay lost the response to `start`, the driver sent it again,
 * and the run forked into three workflows for one request. Two of them sat in `quick_execution`
 * forever, and each looked healthy on its own.
 */
test("a repeated start rejoins the running workflow instead of forking it", () => {
  const { close, ctx } = context()
  try {
    const shape = { resumed: false, workflowId: "" }
    const first = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "auto") as typeof shape
    const again = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "auto") as typeof shape

    assert.equal(first.resumed, false)
    assert.equal(again.resumed, true)
    assert.equal(again.workflowId, first.workflowId)
  } finally {
    close()
  }
})

test("a different request in the same project starts its own workflow", () => {
  const { close, ctx } = context()
  try {
    const shape = { workflowId: "" }
    const first = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "auto") as typeof shape
    const other = startWorkflow(ctx, "rename another helper", ["src/date.ts"], "auto") as typeof shape

    assert.notEqual(other.workflowId, first.workflowId)
  } finally {
    close()
  }
})

test("an empty request is refused: there is nothing to judge against", () => {
  const { close, ctx } = context()
  try {
    assert.throws(() => startWorkflow(ctx, "   ", [], "auto"), WorkflowError)
  } finally {
    close()
  }
})

test("a plan is only accepted in architecture", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "quick") as {
      workflowId: string
    }

    assert.throws(() => submitPlan(ctx, started.workflowId, PLAN), /only accepted in architecture/u)
  } finally {
    close()
  }
})

test("an unsafe verification command rejects the whole plan", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add oauth login", ["src/auth.ts"], "full") as {
      workflowId: string
    }

    assert.throws(
      () =>
        submitPlan(ctx, started.workflowId, {
          ...PLAN,
          tasks: [{ ...PLAN.tasks[0], verification_commands: ["git push"] }],
        }),
      /git cannot be a verification command/u,
    )
  } finally {
    close()
  }
})

// Certification 4.5.
test("a task reporting a plan defect returns to architecture", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add oauth login", ["src/auth.ts"], "full") as {
      workflowId: string
    }
    submitPlan(ctx, started.workflowId, PLAN)

    const result = reportTask(ctx, started.workflowId, "task-1", "plan_defect", "scope is wrong")
    assert.equal(state(result), "architecture")
  } finally {
    close()
  }
})

// The refusal the product exists for: the arbiter votes approve, the gates never ran, nothing ships.
test("an approval without passing gates is refused and consumes a repair cycle", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add oauth login", ["src/auth.ts"], "full") as {
      workflowId: string
    }
    const id = started.workflowId
    submitPlan(ctx, id, PLAN)
    reportTask(ctx, id, "task-1", "completed", "done")
    freezeCandidate(ctx, id, emptyCandidate())
    verifyCandidate(ctx, id, { evidenceIds: ["e1"], mandatoryPassed: true, reason: "" })
    submitReviewVerdict(ctx, id, "functional_reviewer", APPROVAL)
    submitReviewVerdict(ctx, id, "security_reviewer", APPROVAL)

    const result = arbitrate(ctx, id, APPROVAL, false) as {
      decision: string
      refusal: string | null
      repair: { used: number }
      state: string
    }

    assert.equal(result.decision, "approved")
    assert.match(result.refusal ?? "", /mandatory verification gates have not passed/u)
    assert.equal(result.state, "repair")
    assert.equal(result.repair.used, 1)
  } finally {
    close()
  }
})

test("an approval with passing gates reaches delivery", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    const result = arbitrate(ctx, id, APPROVAL, true) as { refusal: string | null; state: string }

    assert.equal(result.state, "delivery")
    assert.equal(result.refusal, null)
  } finally {
    close()
  }
})

test("arbitration cannot approve while a reviewer rejected the candidate", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx, [REJECTION, APPROVAL])

    assert.throws(() => arbitrate(ctx, id, APPROVAL, true), /a reviewer rejected/u)
  } finally {
    close()
  }
})

test("arbitration in full mode requires both reviews", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add oauth login", ["src/auth.ts"], "full") as {
      workflowId: string
    }
    const id = started.workflowId
    submitPlan(ctx, id, PLAN)
    reportTask(ctx, id, "task-1", "completed", "done")
    freezeCandidate(ctx, id, emptyCandidate())
    verifyCandidate(ctx, id, { evidenceIds: [], mandatoryPassed: true, reason: "" })
    submitReviewVerdict(ctx, id, "functional_reviewer", APPROVAL)

    assert.throws(() => arbitrate(ctx, id, APPROVAL, true), /only accepted in arbitration/u)
  } finally {
    close()
  }
})

// Certification 6.9.
test("a verdict citing evidence that was never supplied is refused", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)

    assert.throws(
      () =>
        arbitrate(
          ctx,
          id,
          {
            ...APPROVAL,
            requirements: [{ evidence_ids: [newId()], requirement_id: "REQ-1", status: "satisfied" }],
          },
          true,
        ),
      VerdictRejected,
    )
  } finally {
    close()
  }
})

test("failed verification sends the workflow back to repair", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "quick") as {
      workflowId: string
    }
    const id = started.workflowId
    freezeCandidate(ctx, id, emptyCandidate())

    const result = verifyCandidate(ctx, id, {
      evidenceIds: [],
      mandatoryPassed: false,
      reason: "no gate ran",
    })

    assert.equal(state(result), "repair")
  } finally {
    close()
  }
})

// Certification 4.6.
test("a cancelled workflow accepts nothing further", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "quick") as {
      workflowId: string
    }
    const id = started.workflowId
    control(ctx, id, "cancel")

    assert.equal(loadWorkflow(ctx.database, id)?.state, "cancelled")
    assert.throws(() => freezeCandidate(ctx, id, emptyCandidate()), /not valid/u)
  } finally {
    close()
  }
})

// Certification 4.10.
test("a workflow from another project is not addressable", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "quick") as {
      workflowId: string
    }
    const other: ServiceContext = { ...ctx, projectId: "p2" }

    assert.throws(
      () => freezeCandidate(other, started.workflowId, emptyCandidate()),
      /another project/u,
    )
  } finally {
    close()
  }
})

test("every step is written to the tamper-evident history", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    arbitrate(ctx, id, APPROVAL, true)

    const actions = ctx.database
      .all<{ action: string }>("select action from history order by sequence")
      .map((row) => row.action)

    assert.deepEqual(actions, [
      "workflow.started",
      "architecture.accepted",
      "execution.task_completed",
      "candidate.frozen",
      "verification.completed",
      "review.submitted",
      "review.submitted",
      "arbitration.approved",
    ])
  } finally {
    close()
  }
})

// Without this the repair loop dead-ends: every rejection leaves the workflow in repair and the
// next operation is refused, so a rejected candidate could never be repaired.
test("a rejected candidate re-enters execution through a repair", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    assert.equal(state(arbitrate(ctx, id, REJECTION, true)), "repair")

    const resumed = control(ctx, id, "repair") as { repairTarget: string; state: string }
    assert.equal(resumed.state, "execution")
    assert.equal(resumed.repairTarget, "execution")
    assert.equal(loadWorkflow(ctx.database, id)?.candidateId, null)

    // The second cycle runs to arbitration exactly like the first.
    reportTask(ctx, id, "task-1", "completed", "repaired")
    freezeCandidate(ctx, id, emptyCandidate())
    verifyCandidate(ctx, id, { evidenceIds: [], mandatoryPassed: true, reason: "gates passed" })
    submitReviewVerdict(ctx, id, "functional_reviewer", APPROVAL)
    submitReviewVerdict(ctx, id, "security_reviewer", APPROVAL)
    assert.equal(state(arbitrate(ctx, id, APPROVAL, true)), "delivery")
  } finally {
    close()
  }
})

test("a repair blamed on the architecture returns to architecture, not execution", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    arbitrate(ctx, id, { ...REJECTION, repair_target: "architecture" }, true)

    assert.equal(state(control(ctx, id, "repair")), "architecture")
  } finally {
    close()
  }
})

// The quick route has no architect, so there is no requirement matrix to decide. The arbiter still
// judges, against the original request itself.
test("the quick route arbitrates without a plan", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "fix the typo in the footer", ["src/footer.tsx"], "quick") as {
      state: string
      workflowId: string
    }
    assert.equal(started.state, "quick_execution")

    freezeCandidate(ctx, started.workflowId, emptyCandidate())
    verifyCandidate(ctx, started.workflowId, {
      evidenceIds: [],
      mandatoryPassed: true,
      reason: "gates passed",
    })

    const decided = arbitrate(
      ctx,
      started.workflowId,
      { decision: "approved", findings: [], repair_target: null, requirements: [] },
      true,
    )
    assert.equal(state(decided), "delivery")
  } finally {
    close()
  }
})

test("review evidence carries the bytes frozen by the control plane", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add the certification marker", ["marker.txt"], "quick") as {
      workflowId: string
    }
    const payload = new TextEncoder().encode("frozen bytes\n")
    freezeCandidate(ctx, started.workflowId, {
      manifest: {
        ...emptyCandidate().manifest,
        files: [{ digest: "abc", kind: "added", path: "marker.txt" }],
      },
      payloads: new Map([["marker.txt", payload]]),
    })

    const evidence = candidateEvidence(ctx, started.workflowId) as {
      frozenCandidate: { files: { content: string | null; path: string }[] }
    }
    assert.deepEqual(evidence.frozenCandidate.files, [
      {
        content: "frozen bytes\n",
        contentReason: null,
        digest: "abc",
        kind: "added",
        path: "marker.txt",
      },
    ])
  } finally {
    close()
  }
})

// Emptiness is tolerated only where there is nothing to decide: a plan's requirements still must
// all be decided, or an unjudged requirement would ship inside an approval.
test("an empty verdict is still refused when the plan has requirements", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    assert.throws(
      () => arbitrate(ctx, id, { ...APPROVAL, requirements: [] }, true),
      VerdictRejected,
    )
  } finally {
    close()
  }
})

function seedEvidence(
  ctx: ServiceContext,
  candidateId: string,
  gate: string,
  status: string,
  mandatory = 1,
): string {
  const id = newId()
  ctx.database.run(
    `insert into evidence (
       id, candidate_id, gate_name, kind, status, mandatory, invocation,
       started_at, finished_at, output, output_digest
     ) values (?, ?, ?, 'test', ?, ?, 'x', 0, 0, '', 'd')`,
    id,
    candidateId,
    gate,
    status,
    mandatory,
  )
  return id
}

const currentCandidate = (ctx: ServiceContext, workflowId: string): string =>
  loadWorkflow(ctx.database, workflowId)!.candidateId!

// Evidence accumulates across repair cycles. Judging a repaired candidate on the gates of the one
// it replaced would make the first failure permanent and the repair budget meaningless.
test("only the current candidate's gates decide whether approval is permitted", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    seedEvidence(ctx, currentCandidate(ctx, id), "test:first", "failed")
    assert.equal(mandatoryGatesPassed(ctx, id), false)

    arbitrate(ctx, id, REJECTION, false)
    control(ctx, id, "repair")
    reportTask(ctx, id, "task-1", "completed", "repaired")
    freezeCandidate(ctx, id, emptyCandidate())
    seedEvidence(ctx, currentCandidate(ctx, id), "test:second", "passed")

    assert.equal(mandatoryGatesPassed(ctx, id), true)
  } finally {
    close()
  }
})

test("a non-mandatory gate that failed does not block approval", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    const candidateId = currentCandidate(ctx, id)
    seedEvidence(ctx, candidateId, "test:required", "passed")
    seedEvidence(ctx, candidateId, "essentiality:reimplementation", "failed", 0)

    assert.equal(mandatoryGatesPassed(ctx, id), true)
  } finally {
    close()
  }
})

test("no recorded gate at all is not an approval", () => {
  const { close, ctx } = context()
  try {
    assert.equal(mandatoryGatesPassed(ctx, toArbitration(ctx)), false)
  } finally {
    close()
  }
})

// Evidence identifiers are the only citations a reviewer may use, and they belong to the candidate
// under review.
test("evidence from a replaced candidate cannot be cited", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    const stale = seedEvidence(ctx, currentCandidate(ctx, id), "test:first", "passed")

    arbitrate(ctx, id, REJECTION, false)
    control(ctx, id, "repair")
    reportTask(ctx, id, "task-1", "completed", "repaired")
    freezeCandidate(ctx, id, emptyCandidate())
    const fresh = seedEvidence(ctx, currentCandidate(ctx, id), "test:second", "passed")
    verifyCandidate(ctx, id, { evidenceIds: [fresh], mandatoryPassed: true, reason: "gates passed" })
    submitReviewVerdict(ctx, id, "functional_reviewer", APPROVAL)
    submitReviewVerdict(ctx, id, "security_reviewer", APPROVAL)

    const cite = (evidenceId: string) => ({
      ...APPROVAL,
      requirements: [{ evidence_ids: [evidenceId], requirement_id: "REQ-1", status: "satisfied" }],
    })

    assert.throws(() => arbitrate(ctx, id, cite(stale), true), /cited evidence/u)
    assert.equal(state(arbitrate(ctx, id, cite(fresh), true)), "delivery")
  } finally {
    close()
  }
})

test("reconciliation of a project with no workflow says so rather than inventing one", async () => {
  const { close, ctx } = context()
  try {
    const reconciled = (await reconcile(ctx, ".")) as { found: boolean; next: string }

    assert.equal(reconciled.found, false)
    assert.match(reconciled.next, /nothing to resume/u)
  } finally {
    close()
  }
})

// A fresh session has no idea where the last one stopped. This is how it finds out.
// Certification 3.4.
test("reconciliation reports the state and what has to happen next", async () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    arbitrate(ctx, id, REJECTION, false)

    const reconciled = (await reconcile(ctx, ".")) as {
      chain: boolean
      next: string
      repair: { max: number; used: number }
      state: string
      workflowId: string
    }

    assert.equal(reconciled.workflowId, id)
    assert.equal(reconciled.state, "repair")
    assert.match(reconciled.next, /repair cycle/u)
    assert.equal(reconciled.repair.used, 1)
    assert.equal(reconciled.chain, true)
  } finally {
    close()
  }
})

test("a workflow from another project is not reconciled", async () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    const other: ServiceContext = { ...ctx, projectId: "p2" }

    assert.equal(((await reconcile(other, ".", id)) as { found: boolean }).found, false)
  } finally {
    close()
  }
})

// Certification 3.7.
test("history reports the chain, its signatures and the entries in order", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)

    const state = historyState(ctx, 10) as {
      chain: { valid: boolean }
      checkpoint: { sequence: number } | null
      entries: { action: string; sequence: number }[]
      signatures: { valid: boolean }
    }

    assert.equal(state.chain.valid, true)
    assert.equal(state.signatures.valid, true)
    assert.equal(state.checkpoint?.sequence, 0)
    assert.equal(state.entries[0]?.action, "workflow.started")
    assert.equal(state.entries[0]?.sequence, 0)
    assert.ok(state.entries.some((entry) => entry.action === "candidate.frozen"))
    assert.ok(id.length > 0)
  } finally {
    close()
  }
})

// Signatures must survive a hard kill: certification 7.5. Cancelling anchors the chain where it
// ended, so a project that never delivered still has something to verify against.
test("cancelling a workflow anchors the chain with a signed checkpoint", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    control(ctx, id, "cancel")

    const state = historyState(ctx, 100) as {
      checkpoint: { sequence: number } | null
      entries: { sequence: number }[]
      signatures: { valid: boolean }
    }

    assert.equal(state.signatures.valid, true)
    assert.equal(state.checkpoint?.sequence, state.entries.at(-1)?.sequence)
  } finally {
    close()
  }
})

// Certification 11.4: a provider that stops answering is not a rejection. Nothing about the
// candidate changed, so nothing about the candidate may be spent.
test("a provider failure pauses the workflow with its reason and spends no repair cycle", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    const before = workflowStatus(ctx, id) as { repair: { used: number }; state: string }

    const paused = control(
      ctx,
      id,
      "pause",
      "provider unavailable: the arbiter produced no answer",
    ) as { reason: string; state: string }

    assert.equal(paused.state, "paused")
    assert.equal(paused.reason, "provider unavailable: the arbiter produced no answer")

    const status = workflowStatus(ctx, id) as {
      pausedBecause: string | null
      repair: { used: number }
      state: string
    }
    assert.equal(status.state, "paused")
    assert.equal(status.pausedBecause, "provider unavailable: the arbiter produced no answer")
    assert.equal(status.repair.used, before.repair.used)

    // Recoverable: it returns to exactly the stage the provider abandoned, candidate intact.
    const resumed = control(ctx, id, "resume") as { state: string }
    assert.equal(resumed.state, before.state)
    assert.equal(loadWorkflow(ctx.database, id)?.candidateId !== null, true)
    assert.equal((workflowStatus(ctx, id) as { pausedBecause: string | null }).pausedBecause, null)
  } finally {
    close()
  }
})

test("the classification is kept in the chain, not only in the answer", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    control(ctx, id, "pause", "provider unavailable: the arbiter produced no answer")

    const history = historyState(ctx, 100, undefined) as {
      entries: { action: string; metadata: Record<string, string> }[]
    }
    const entry = history.entries.findLast((item) => item.action === "control.pause")

    assert.equal(entry?.metadata["reason"], "provider unavailable: the arbiter produced no answer")
  } finally {
    close()
  }
})

test("a pause with no reason reports none rather than inventing one", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    const paused = control(ctx, id, "pause") as { reason?: string; state: string }

    assert.equal(paused.state, "paused")
    assert.equal(paused.reason, undefined)
    assert.equal((workflowStatus(ctx, id) as { pausedBecause: string | null }).pausedBecause, null)
  } finally {
    close()
  }
})

test("an oversized reason is bounded rather than refused", () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    const paused = control(ctx, id, "pause", "x".repeat(2_000)) as { reason: string }

    assert.equal(paused.reason.length, 512)
  } finally {
    close()
  }
})

// /cycle:resume is the recovery path, so it must say why the workflow is standing still.
test("reconcile reports why a workflow paused", async () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)
    control(ctx, id, "pause", "provider unavailable: the executor produced no answer")

    const result = (await reconcile(ctx, process.cwd(), id)) as {
      next: string
      pausedBecause: string | null
      state: string
    }

    assert.equal(result.state, "paused")
    assert.equal(result.pausedBecause, "provider unavailable: the executor produced no answer")
    assert.match(result.next, /\/cycle:resume/u)
  } finally {
    close()
  }
})

/**
 * Found by a real run: the driver wrote two tasks' files before reporting the first, was told the
 * paths were outside every authorized scope, and moved them aside with `git stash` to get past the
 * check. The refusal stands either way — only the diagnosis differs, and the wrong diagnosis is
 * what produced the workaround.
 */
test("a path owned by a task that has not been reported names that task, not a violation", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }
    submitPlan(ctx, started.workflowId, {
      ...PLAN,
      tasks: [
        PLAN.tasks[0]!,
        { ...PLAN.tasks[0]!, key: "task-2", title: "Tests", write_scopes: ["tests/health"] },
      ],
    })

    const reported = reportTask(ctx, started.workflowId, "task-1", "completed", "done", [
      "src/health/route.ts",
      "tests/health/route.test.ts",
    ]) as { outOfScope: string[]; reason: string; unreportedTasks: string[] }

    assert.deepEqual(reported.outOfScope, ["tests/health/route.test.ts"])
    assert.deepEqual(reported.unreportedTasks, ["task-2"])
    assert.match(reported.reason, /owned by task-2/u)
    assert.match(reported.reason, /Do not move the changes aside/u)
    assert.doesNotMatch(reported.reason, /outside every write scope/u)
  } finally {
    close()
  }
})

// Certification 6.4: layer three of section 5.2. The executor's own account of what it did is
// never the record of what it did.
test("a task that changed a path no scope authorized is rejected at reconciliation", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }
    submitPlan(ctx, started.workflowId, PLAN)

    const reported = reportTask(ctx, started.workflowId, "task-1", "completed", "done", [
      "src/health/route.ts",
      "src/billing/charge.ts",
      ".github/workflows/release.yml",
    ]) as { outOfScope: string[]; reason: string; state: string }

    assert.deepEqual(reported.outOfScope, [".github/workflows/release.yml", "src/billing/charge.ts"])
    assert.match(reported.reason, /outside every write scope/u)
    assert.equal(reported.state, "repair")

    const status = workflowStatus(ctx, started.workflowId) as {
      repair: { used: number }
      tasks: { state: string }[]
    }
    assert.equal(status.repair.used, 1)
    assert.equal(status.tasks[0]?.state, "blocked")
  } finally {
    close()
  }
})

test("a task that stayed inside its scopes reconciles and completes", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }
    submitPlan(ctx, started.workflowId, PLAN)

    const reported = reportTask(ctx, started.workflowId, "task-1", "completed", "done", [
      "src/health",
      "src/health/route.ts",
      "src/health/nested/deep/handler.ts",
    ]) as { remaining: string[]; state: string }

    assert.deepEqual(reported.remaining, [])
    assert.equal(reported.state, "execution")
  } finally {
    close()
  }
})

// A scope prefix that merely looks like the path is not the path: `src/health-admin` is a different
// directory from `src/health`, and a prefix comparison that missed that would authorize it.
test("a sibling directory sharing a prefix is not inside the scope", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }
    submitPlan(ctx, started.workflowId, PLAN)

    const reported = reportTask(ctx, started.workflowId, "task-1", "completed", "done", [
      "src/health-admin/route.ts",
    ]) as { outOfScope: string[] }

    assert.deepEqual(reported.outOfScope, ["src/health-admin/route.ts"])
  } finally {
    close()
  }
})

test("the quick route has no plan, so reconciliation authorizes nothing and blocks nothing", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "rename a helper", ["src/date.ts"], "quick") as {
      workflowId: string
    }
    const reported = reportTask(ctx, started.workflowId, "task-1", "completed", "done", [
      "src/date.ts",
    ]) as { state: string }

    assert.equal(reported.state, "quick_execution")
  } finally {
    close()
  }
})

test("the scope violation is recorded in the chain with the paths that caused it", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }
    submitPlan(ctx, started.workflowId, PLAN)
    reportTask(ctx, started.workflowId, "task-1", "completed", "done", ["src/billing/charge.ts"])

    const history = historyState(ctx, 100, undefined) as {
      entries: { action: string; metadata: Record<string, string> }[]
    }
    const entry = history.entries.findLast((item) => item.action === "execution.scope_violation")

    assert.equal(entry?.metadata["paths"], "src/billing/charge.ts")
    assert.equal(entry?.metadata["task"], "task-1")
  } finally {
    close()
  }
})

// Certification 6.7: the standalone judge produces a readiness report. Approval is a control-plane
// operation that needs a workflow in arbitration with a frozen candidate, so there is no path from
// a consultation to an approval — not a rule the arbiter is asked to respect, a route that is absent.
test("a readiness assessment has no workflow to approve, and approval refuses without one", () => {
  const { close, ctx } = context()
  try {
    assert.throws(() => arbitrate(ctx, newId(), APPROVAL, true), WorkflowError)

    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }
    submitPlan(ctx, started.workflowId, PLAN)

    // In execution there is nothing frozen to judge, and the control plane refuses to be asked.
    assert.throws(() => arbitrate(ctx, started.workflowId, APPROVAL, true), {
      message: /only accepted in arbitration/u,
    })
    assert.equal(mandatoryGatesPassed(ctx, started.workflowId), false)
  } finally {
    close()
  }
})

/**
 * The reviewers wrote down exactly what was wrong, the plane refused delivery over it, and nobody
 * repairing was ever told. Each repair cycle rediscovered the finding or missed it, and the budget
 * paid for the rediscovery.
 */
test("what the last refusal said is carried back for the repair", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }
    const id = started.workflowId
    submitPlan(ctx, id, PLAN)
    reportTask(ctx, id, "task-1", "completed", "done")
    freezeCandidate(ctx, id, emptyCandidate())
    verifyCandidate(ctx, id, { evidenceIds: ["e1"], mandatoryPassed: true, reason: "" })

    submitReviewVerdict(ctx, id, "functional_reviewer", APPROVAL)
    submitReviewVerdict(ctx, id, "security_reviewer", REJECTION)
    arbitrate(ctx, id, REJECTION, true)

    const status = workflowStatus(ctx, id) as {
      lastRefusal: { findings: { summary: string }[]; from: string }[]
    }

    // The reviewer that approved names nothing to fix and is left out.
    assert.deepEqual(
      status.lastRefusal.map((refusal) => refusal.from),
      ["security_reviewer", "arbiter"],
    )
    assert.match(status.lastRefusal[0]!.findings[0]!.summary, /no test covers the flow/u)
  } finally {
    close()
  }
})

test("a workflow that has never been refused carries nothing", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "expose health", ["src/health"], "full") as {
      workflowId: string
    }

    assert.deepEqual((workflowStatus(ctx, started.workflowId) as { lastRefusal: [] }).lastRefusal, [])
  } finally {
    close()
  }
})

// Every role ran on the session model for as long as this went untested. The run took its models
// from a map the caller was told to assemble, and a caller that skipped that step produced a run
// which looked correct and used one model throughout. The plane holds the configuration, so it
// states it.
test("start states the model each role runs on", () => {
  const { close, ctx } = context()
  try {
    const configured = {
      ...ctx.configuration,
      roles: {
        ...ctx.configuration.roles,
        architect: { effort: "high", model: "pro" },
        executor: { effort: "medium", model: "flash" },
      },
    }
    const started = startWorkflow(
      { ...ctx, configuration: configured as typeof ctx.configuration },
      "rename a local variable",
      [],
      "quick",
    ) as { roles: Record<string, { model: string | null; subagentModel: string | null }> }
    const role = (name: string) => started.roles[name] ?? assert.fail(`${name} is not reported`)

    assert.equal(role("architect").model, "pro")
    assert.equal(role("executor").model, "flash")
    assert.equal(role("architect").subagentModel, "pro")
    assert.equal(role("executor").subagentModel, "flash")
    assert.equal(role("functional-reviewer").subagentModel, "flash")
  } finally {
    close()
  }
})

// The scope gate reconciles what a task wrote against what the plan authorized it to write. The
// change set arrived from git, and git failing was flattened to an empty array by the caller, so an
// unreadable worktree read as "this task wrote nothing" and every scope check passed vacuously.
test("a change set that could not be read does not complete a task", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add oauth login to the dashboard", [], "full") as {
      workflowId: string
    }
    const id = started.workflowId
    submitPlan(ctx, id, PLAN)

    const refused = reportTask(ctx, id, "task-1", "completed", "done", null) as {
      reason: string
      retry: boolean
    }
    assert.equal(refused.retry, true)
    assert.match(refused.reason, /could not be read/u)

    const tasks = (workflowStatus(ctx, id) as { tasks: { key: string; state: string }[] }).tasks
    assert.notEqual(tasks.find((task) => task.key === "task-1")?.state, "completed")
  } finally {
    close()
  }
})

// The reviewer asks the control plane to run code it wrote. That capability is granted deliberately
// or not at all: the default install refuses, and says what to do instead.
test("a proof is refused unless executing proofs was turned on", async () => {
  const { close, ctx } = context()
  try {
    const id = toArbitration(ctx)

    await assert.rejects(
      () =>
        submitSecurityProof(ctx, id, ".", {
          rationale: "show the injection",
          script: "process.exit(0)",
          vulnerabilityClass: "injection",
        }),
      /security_proofs/u,
    )
  } finally {
    close()
  }
})

const FLOW = {
  capturedFlow: "opened the dashboard",
  nodes: [{ children: [], level: 1, name: "Main", role: "main" }],
  url: "http://localhost:3000/",
}

// Over stdio the plane reads a line; it has no notion of who wrote it. A submission that named its
// own role was therefore a claim anyone could make, and the party the gate exists to check could
// make it. The role now comes from a secret the plane issued and delivered to one role.
test("the role a capture is credited to comes from the capability, not the caller", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "restyle the banner", [], "full") as { workflowId: string }
    const id = started.workflowId
    submitPlan(ctx, id, PLAN)
    reportTask(ctx, id, "task-1", "completed", "done")
    const frozen = freezeCandidate(ctx, id, emptyCandidate()) as {
      captureCapabilities: { role: string; token: string }[]
    }

    // One per reviewing role, and the executor is not one of them.
    assert.deepEqual(
      frozen.captureCapabilities.map((entry) => entry.role).sort(),
      ["functional_reviewer", "security_reviewer"],
    )

    const security = frozen.captureCapabilities.find((entry) => entry.role === "security_reviewer")!
    const credited = submitBrowserEvidence(ctx, id, FLOW, security.token) as { capturedBy?: string }
    assert.equal(credited.capturedBy, "security_reviewer")

    // Spent once. A capability that survived its use would be a password shared with everyone who
    // ever saw a transcript.
    assert.throws(() => submitBrowserEvidence(ctx, id, FLOW, security.token), /already spent/u)
  } finally {
    close()
  }
})

test("a capability nobody was issued is refused, and no role is credited", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "restyle the banner", [], "full") as { workflowId: string }
    const id = started.workflowId
    submitPlan(ctx, id, PLAN)
    reportTask(ctx, id, "task-1", "completed", "done")
    freezeCandidate(ctx, id, emptyCandidate())

    assert.throws(() => submitBrowserEvidence(ctx, id, FLOW, "not-a-token"), /not valid/u)

    // Submitting without one stays open: that is the executor reporting its own work, which is
    // recorded and carries no weight.
    const reported = submitBrowserEvidence(ctx, id, FLOW) as { capturedBy?: string }
    assert.equal(reported.capturedBy, "executor")
  } finally {
    close()
  }
})

// The layer that tells a person what a run did is prose written by a model, and prose drifts. A
// workflow stopped in delivery on the quick route with no reviews was reported as "completed, full
// cycle, seven agents". The plane cannot stop a caller paraphrasing, but it can hand it a sentence
// built from the record, so that a paraphrase is visibly not the sentence.
test("status carries a summary built from the record, not from an account of it", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "add oauth login to the dashboard", [], "full") as {
      workflowId: string
    }
    const id = started.workflowId
    submitPlan(ctx, id, PLAN)

    const early = (workflowStatus(ctx, id) as { summary: string }).summary
    assert.match(early, /route full/u)
    assert.match(early, /tasks 0\/1/u)
    assert.match(early, /reviews 0/u)
    assert.match(early, /not delivered/u)

    reportTask(ctx, id, "task-1", "completed", "done")
    const later = (workflowStatus(ctx, id) as { summary: string }).summary
    assert.match(later, /tasks 1\/1/u)
    // The counts move with the record; nothing here is written by whoever reports it.
    assert.notEqual(early, later)
  } finally {
    close()
  }
})

// A resume once passed its whole argument list where the request belongs, which opened a second
// workflow on `request="..." workflowId="..."` and left the real one orphaned. The arbiter judges
// the delivered work against this text, so a serialisation here would have been judged literally.
test("a request that is really an argument list is refused", () => {
  const { close, ctx } = context()
  try {
    assert.throws(
      () =>
        startWorkflow(
          ctx,
          'request="add a percentage discount to the checkout total" workflowId="e84cde16"',
          [],
          "auto",
        ),
      /argument list/u,
    )

    // The sentence it wrapped is still an ordinary request.
    const fine = startWorkflow(ctx, "add a percentage discount to the checkout total", [], "auto") as {
      workflowId: string
    }
    assert.ok(fine.workflowId)
  } finally {
    close()
  }
})

// Five configured models, a stale server, and a run that said nothing: every role inherited the
// session model and the only visible sign was haiku on the relay rows, which is its ordinary
// default. The plane counts the options that reached it, so it can tell a deliberate inherit from a
// configuration that never arrived — and it says so on the line every report quotes verbatim.
test("a run whose plane received no option says so where it will be read", () => {
  const { close, ctx } = context()
  try {
    const started = startWorkflow(ctx, "rename a helper", [], "quick") as { workflowId: string }
    const undelivered = (workflowStatus(ctx, started.workflowId) as { summary: string }).summary
    assert.match(undelivered, /no plugin option reached this process/u)

    // An install that did receive its options says nothing extra: the note marks a failure, not a
    // configuration that happens to leave roles on inherit.
    const configured = {
      ...ctx,
      configuration: { ...ctx.configuration, delivered: 14 },
    }
    const fine = (workflowStatus(configured, started.workflowId) as { summary: string }).summary
    assert.doesNotMatch(fine, /no plugin option reached/u)

    // The other shape of the same failure: the variables arrived, carrying nothing. The note keeps
    // the opening words the workflow script matches on and adds what it actually found.
    const hollow = {
      ...ctx,
      configuration: { ...ctx.configuration, blank: 14, delivered: 0 },
    }
    const empty = (workflowStatus(hollow, started.workflowId) as { summary: string }).summary
    assert.match(empty, /no plugin option reached this process/u)
    assert.match(empty, /14 arrived empty/u)
  } finally {
    close()
  }
})
