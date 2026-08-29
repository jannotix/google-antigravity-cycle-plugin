import assert from "node:assert/strict"
import { test } from "node:test"

import {
  apply,
  isTerminal,
  newWorkflow,
  TransitionError,
  type Workflow,
  type WorkflowCommand,
} from "../src/workflow/machine.ts"

const drive = (workflow: Workflow, ...commands: WorkflowCommand[]): Workflow =>
  commands.reduce(apply, workflow)

const toArbitration = (mode: "full" | "quick" = "full"): Workflow =>
  drive(
    newWorkflow(5),
    { type: "complete_intake" },
    { mode, type: "route" },
    ...(mode === "full" ? ([{ type: "architecture_accepted" }] as WorkflowCommand[]) : []),
    { candidateId: "c1", type: "candidate_ready" },
    { type: "verification_passed" },
    ...(mode === "full" ? ([{ type: "reviews_ready" }] as WorkflowCommand[]) : []),
  )

// Certification 3.2.
test("the full route goes through architecture and both reviews", () => {
  assert.equal(toArbitration("full").state, "arbitration")
})

// Certification 3.2, 4.1.
test("the quick route skips architecture and the reviews", () => {
  const routed = drive(newWorkflow(5), { type: "complete_intake" }, { mode: "quick", type: "route" })

  assert.equal(routed.state, "quick_execution")
  assert.equal(toArbitration("quick").state, "arbitration")
})

// The single most important refusal in the product.
test("approval is refused when the mandatory gates have not passed", () => {
  const workflow = toArbitration()

  assert.throws(
    () => apply(workflow, { mandatoryGatesPassed: false, type: "approve" }),
    (error: unknown) =>
      error instanceof TransitionError && error.code === "gates_not_passed",
  )
})

test("approval with passing gates reaches delivery, and delivery completes", () => {
  const approved = apply(toArbitration(), { mandatoryGatesPassed: true, type: "approve" })

  assert.equal(approved.state, "delivery")
  assert.equal(apply(approved, { type: "deliver" }).state, "completed")
})

test("a rejection consumes a repair cycle", () => {
  const rejected = apply(toArbitration(), { target: "execution", type: "reject" })

  assert.equal(rejected.state, "repair")
  assert.equal(rejected.repairCycles, 1)
  assert.equal(rejected.repairTarget, "execution")
})

test("repair returns to execution or architecture as the target says", () => {
  const execution = drive(
    toArbitration(),
    { target: "execution", type: "reject" },
    { type: "begin_repair" },
  )
  const architecture = drive(
    toArbitration(),
    { target: "architecture", type: "reject" },
    { type: "begin_repair" },
  )

  assert.equal(execution.state, "execution")
  assert.equal(architecture.state, "architecture")
  assert.equal(execution.candidateId, null)
})

// Certification 4.4.
test("exhausting the repair budget blocks instead of looping forever", () => {
  let workflow = newWorkflow(2)
  workflow = drive(workflow, { type: "complete_intake" }, { mode: "quick", type: "route" })

  workflow = drive(
    workflow,
    { candidateId: "c1", type: "candidate_ready" },
    { target: "execution", type: "verification_failed" },
  )
  assert.equal(workflow.state, "repair")

  workflow = drive(
    workflow,
    { type: "begin_repair" },
    { candidateId: "c2", type: "candidate_ready" },
    { target: "execution", type: "verification_failed" },
  )
  assert.equal(workflow.state, "blocked")
  assert.equal(workflow.repairCycles, 2)
})

// Certification 3.4, 4.4.
test("a blocked workflow resumes with an extended budget", () => {
  let workflow = drive(
    newWorkflow(1),
    { type: "complete_intake" },
    { mode: "quick", type: "route" },
    { candidateId: "c1", type: "candidate_ready" },
    { target: "execution", type: "verification_failed" },
  )
  assert.equal(workflow.state, "blocked")

  workflow = apply(workflow, { additionalCycles: 2, type: "resume_blocked" })
  assert.equal(workflow.state, "repair")
  assert.equal(workflow.maxRepairCycles, 3)
})

test("resuming blocked work requires at least one extra cycle", () => {
  const blocked = drive(
    newWorkflow(1),
    { type: "complete_intake" },
    { mode: "quick", type: "route" },
    { candidateId: "c1", type: "candidate_ready" },
    { target: "execution", type: "verification_failed" },
  )

  assert.throws(
    () => apply(blocked, { additionalCycles: 0, type: "resume_blocked" }),
    (error: unknown) => error instanceof TransitionError && error.code === "out_of_range",
  )
})

test("verification cannot start without a candidate", () => {
  const routed = drive(newWorkflow(5), { type: "complete_intake" }, { mode: "quick", type: "route" })

  assert.throws(() => apply(routed, { type: "verification_passed" }), TransitionError)
})

// Certification 3.4.
test("pause preserves the state it interrupted and resume restores it", () => {
  const executing = drive(
    newWorkflow(5),
    { type: "complete_intake" },
    { mode: "full", type: "route" },
    { type: "architecture_accepted" },
  )
  const paused = apply(executing, { type: "pause" })

  assert.equal(paused.state, "paused")
  assert.equal(paused.pausedFrom, "execution")
  assert.equal(apply(paused, { type: "resume" }).state, "execution")
})

// Pausing between freezing a candidate and judging it would leave the two out of step.
test("verification and delivery cannot be paused", () => {
  const verifying = drive(
    newWorkflow(5),
    { type: "complete_intake" },
    { mode: "quick", type: "route" },
    { candidateId: "c1", type: "candidate_ready" },
  )

  assert.throws(() => apply(verifying, { type: "pause" }), TransitionError)
})

test("an operation in the wrong state is refused, not reordered", () => {
  const intake = newWorkflow(5)

  assert.throws(() => apply(intake, { type: "architecture_accepted" }), TransitionError)
  assert.throws(() => apply(intake, { type: "deliver" }), TransitionError)
  assert.throws(() => apply(intake, { type: "reviews_ready" }), TransitionError)
})

// Certification 4.6.
test("a completed workflow cannot be cancelled or restarted", () => {
  const completed = apply(
    apply(toArbitration(), { mandatoryGatesPassed: true, type: "approve" }),
    { type: "deliver" },
  )

  assert.equal(isTerminal(completed.state), true)
  assert.throws(() => apply(completed, { type: "cancel" }), TransitionError)
})

// Certification 4.5.
test("an execution-time plan defect returns to architecture without consuming a repair cycle", () => {
  const executing = drive(
    newWorkflow(5),
    { type: "complete_intake" },
    { mode: "full", type: "route" },
    { type: "architecture_accepted" },
  )
  const replanned = apply(executing, { type: "replan" })

  assert.equal(replanned.state, "architecture")
  assert.equal(replanned.repairCycles, 0)
})

// The defect certification found: reporting a task the executor could not finish asked the machine
// for a rejection, which only arbitration allows, so the call threw instead of consuming a cycle.
test("execution can fail before there is a candidate and still costs a repair cycle", () => {
  const started = apply(apply(newWorkflow(5), { type: "complete_intake" }), { mode: "full", type: "route" })
  const executing = apply(started, { type: "architecture_accepted" })

  const failed = apply(executing, { target: "execution", type: "execution_failed" })

  assert.equal(failed.state, "repair")
  assert.equal(failed.repairCycles, 1)
  assert.equal(failed.candidateId, null)
})

test("the quick route can fail in execution too", () => {
  const quick = apply(apply(newWorkflow(5), { type: "complete_intake" }), { mode: "quick", type: "route" })

  assert.equal(apply(quick, { target: "execution", type: "execution_failed" }).state, "repair")
})

test("execution cannot fail from a state that is not executing", () => {
  const started = apply(apply(newWorkflow(5), { type: "complete_intake" }), { mode: "full", type: "route" })

  assert.throws(() => apply(started, { target: "execution", type: "execution_failed" }), {
    code: "invalid_transition",
  })
})

test("execution failing repeatedly blocks on the same budget as any other rejection", () => {
  let workflow = apply(apply(newWorkflow(2), { type: "complete_intake" }), { mode: "quick", type: "route" })
  workflow = apply(workflow, { target: "execution", type: "execution_failed" })
  workflow = apply(apply(workflow, { type: "begin_repair" }), {
    target: "execution",
    type: "execution_failed",
  })

  assert.equal(workflow.state, "blocked")
  assert.equal(workflow.repairCycles, 2)
})
