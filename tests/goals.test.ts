import assert from "node:assert/strict"
import { test } from "node:test"

import {
  abort,
  advance,
  advanceGoalOfWorkflow,
  amend,
  approveCompletion,
  currentPlan,
  extend,
  focus,
  goals,
  GoalRefused,
  link,
  linkStartedWorkflow,
  newGoal,
  pause,
  plan,
  requestCompletion,
  resume,
  status,
  type GoalContext,
} from "../src/goals.ts"
import { Database } from "../src/store/database.ts"
import { newId } from "../src/store/ids.ts"

interface GoalStatus {
  amendments: { sequence: number; text: string }[]
  continuations: { max: number; used: number }
  focused: boolean
  found: boolean
  goalId: string
  milestones: { name: string; state: string; workflowId: string | null }[]
  objective: string
  planVersion: number | null
  remaining: number
  state: string
  successCriteria: string[]
}

function fixture(): { close: () => void; ctx: GoalContext } {
  const database = new Database({ path: ":memory:" })
  return { close: () => database.close(), ctx: { database, projectId: "p1" } }
}

function workflow(ctx: GoalContext, state: string, projectId = "p1"): string {
  const id = newId()
  ctx.database.run(
    `insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at)
     values (?, ?, ?, 5, 1, 1)`,
    id,
    projectId,
    state,
  )
  return id
}

const OBJECTIVE = "replace the session store with a durable one"
const CRITERIA = ["sessions survive a restart", "no user is signed out by the migration"]

const create = (ctx: GoalContext) =>
  newGoal(ctx, { objective: OBJECTIVE, successCriteria: CRITERIA }) as GoalStatus

// Certification 3.6.
test("a new goal is focused, drafted, and judged against its own criteria", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)

    assert.equal(goal.state, "draft")
    assert.equal(goal.focused, true)
    assert.equal(goal.objective, OBJECTIVE)
    assert.deepEqual(goal.successCriteria, CRITERIA)
    assert.deepEqual(goal.continuations, { max: 5, used: 0 })
  } finally {
    close()
  }
})

// A goal nobody can judge is a wish, and it would reach completion by nobody disagreeing.
test("a goal with no success criterion is refused", () => {
  const { close, ctx } = fixture()
  try {
    assert.throws(
      () => newGoal(ctx, { objective: OBJECTIVE, successCriteria: [] }),
      /at least one success criterion/u,
    )
    assert.throws(() => newGoal(ctx, { objective: "  ", successCriteria: CRITERIA }), GoalRefused)
  } finally {
    close()
  }
})

// The objective is what the work is judged against. Editing it would move the target after the fact.
test("the objective is immutable and a clarification is appended", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    assert.throws(
      () => ctx.database.run("update goals set objective = ? where id = ?", "something else", goal.goalId),
      /immutable/u,
    )

    const amended = amend(ctx, goal.goalId, "durable means surviving a machine restart") as GoalStatus
    assert.equal(amended.objective, OBJECTIVE)
    assert.equal(amended.amendments.length, 1)
    assert.equal(amended.amendments[0]?.sequence, 1)
  } finally {
    close()
  }
})

test("a plan is versioned and the previous version is kept", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)

    const first = plan(ctx, goal.goalId, "one milestone: swap the store") as GoalStatus & { version: number }
    assert.equal(first.version, 1)
    assert.equal(first.state, "ready")

    const second = plan(ctx, goal.goalId, "two milestones: swap, then migrate") as { version: number }
    assert.equal(second.version, 2)

    const plans = currentPlan(ctx, goal.goalId) as {
      current: { content: string; version: number } | null
      versions: number[]
    }
    assert.deepEqual(plans.versions, [1, 2])
    assert.equal(plans.current?.content, "two milestones: swap, then migrate")
  } finally {
    close()
  }
})

// Certification 4.8: each milestone is a normal workflow and reports the workflow's own state.
test("a milestone reports the state of the workflow that implements it", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    const running = workflow(ctx, "execution")
    const done = workflow(ctx, "completed")

    link(ctx, goal.goalId, "swap the store", running)
    const linked = link(ctx, goal.goalId, "migrate the sessions", done) as GoalStatus

    assert.equal(linked.state, "active")
    assert.deepEqual(
      linked.milestones.map((milestone) => [milestone.name, milestone.state]),
      [
        ["swap the store", "active"],
        ["migrate the sessions", "completed"],
      ],
    )
    assert.equal(linked.remaining, 1)
  } finally {
    close()
  }
})

test("a milestone without a workflow is pending, and a cancelled one is abandoned", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    link(ctx, goal.goalId, "later work", null)
    const linked = link(ctx, goal.goalId, "cancelled work", workflow(ctx, "cancelled")) as GoalStatus

    assert.deepEqual(
      linked.milestones.map((milestone) => milestone.state).sort(),
      ["abandoned", "pending"],
    )
  } finally {
    close()
  }
})

test("a workflow from another project cannot become a milestone", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)

    assert.throws(
      () => link(ctx, goal.goalId, "foreign", workflow(ctx, "execution", "p2")),
      /another project/u,
    )
    assert.throws(() => link(ctx, goal.goalId, "missing", "no-such-workflow"), /unknown workflow/u)
  } finally {
    close()
  }
})

// Certification 4.9. This is the gate the whole of Goal Mode exists for.
test("completion is refused while any milestone is incomplete", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    link(ctx, goal.goalId, "done", workflow(ctx, "completed"))
    link(ctx, goal.goalId, "still running", workflow(ctx, "verification"))

    assert.throws(() => requestCompletion(ctx, goal.goalId), /still running \(active\)/u)
    assert.equal((status(ctx, goal.goalId) as GoalStatus).state, "active")
  } finally {
    close()
  }
})

test("a goal with no milestone has nothing to complete", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)

    assert.throws(() => requestCompletion(ctx, goal.goalId), /nothing to complete/u)
  } finally {
    close()
  }
})

// Certification 3.6, 3.12.
test("completion takes a request and then an explicit approval", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    link(ctx, goal.goalId, "the work", workflow(ctx, "completed"))

    const requested = requestCompletion(ctx, goal.goalId) as GoalStatus & { judgeAgainst: string[] }
    assert.equal(requested.state, "completing")
    assert.deepEqual(requested.judgeAgainst, CRITERIA)

    assert.throws(() => approveCompletion(ctx, goal.goalId, false), /explicit confirmation/u)
    assert.equal((approveCompletion(ctx, goal.goalId, true) as GoalStatus).state, "completed")
  } finally {
    close()
  }
})

test("approval without a request is refused", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    link(ctx, goal.goalId, "the work", workflow(ctx, "completed"))

    assert.throws(() => approveCompletion(ctx, goal.goalId, true), /only after it is requested/u)
  } finally {
    close()
  }
})

// The gate is checked again at approval: a milestone can be reopened while somebody decides.
test("a milestone that stops being complete between request and approval refuses the approval", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    const workflowId = workflow(ctx, "completed")
    link(ctx, goal.goalId, "the work", workflowId)
    requestCompletion(ctx, goal.goalId)

    ctx.database.run("update workflows set state = 'repair' where id = ?", workflowId)

    assert.throws(() => approveCompletion(ctx, goal.goalId, true), /stopped being complete/u)
    assert.equal((status(ctx, goal.goalId) as GoalStatus).state, "active")
  } finally {
    close()
  }
})

// The same shape as the repair budget: exhausting it preserves everything and blocks deliberately.
test("continuations are spent, exhausted and extended", () => {
  const { close, ctx } = fixture()
  try {
    const goal = newGoal(ctx, {
      maxContinuations: 2,
      objective: OBJECTIVE,
      successCriteria: CRITERIA,
    }) as GoalStatus
    link(ctx, goal.goalId, "first", workflow(ctx, "completed"))

    assert.equal((advance(ctx, goal.goalId) as GoalStatus).state, "active")
    const blocked = advance(ctx, goal.goalId) as GoalStatus
    assert.equal(blocked.state, "blocked")
    assert.deepEqual(blocked.continuations, { max: 2, used: 2 })

    assert.throws(() => advance(ctx, goal.goalId), /only an active goal continues/u)
    const extended = extend(ctx, goal.goalId, 3) as GoalStatus
    assert.equal(extended.state, "active")
    assert.deepEqual(extended.continuations, { max: 5, used: 2 })
  } finally {
    close()
  }
})

test("pausing returns to exactly where it paused", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    link(ctx, goal.goalId, "the work", workflow(ctx, "execution"))

    assert.equal((pause(ctx, goal.goalId) as GoalStatus).state, "paused")
    assert.throws(() => pause(ctx, goal.goalId), /cannot be paused/u)
    assert.equal((resume(ctx, goal.goalId) as GoalStatus).state, "active")
    assert.throws(() => resume(ctx, goal.goalId), /only a paused goal resumes/u)
  } finally {
    close()
  }
})

// Certification 3.12.
test("aborting needs confirmation and is final", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)

    assert.throws(() => abort(ctx, goal.goalId, false), /explicit confirmation/u)
    assert.equal((abort(ctx, goal.goalId, true) as GoalStatus).state, "aborted")
    assert.throws(() => amend(ctx, goal.goalId, "too late"), /aborted goal cannot be amended/u)
    assert.throws(() => focus(ctx, goal.goalId), /cannot be focused/u)
  } finally {
    close()
  }
})

test("focusing one goal releases the other", () => {
  const { close, ctx } = fixture()
  try {
    const first = create(ctx)
    const second = newGoal(ctx, { objective: "a second objective", successCriteria: ["it works"] }) as GoalStatus

    assert.equal((status(ctx, first.goalId) as GoalStatus).focused, false)
    assert.equal((status(ctx) as GoalStatus).goalId, second.goalId, "status with no id uses the focused goal")

    focus(ctx, first.goalId)
    assert.equal((status(ctx) as GoalStatus).goalId, first.goalId)
    assert.equal((goals(ctx) as { goals: { focused: boolean }[] }).goals.filter((g) => g.focused).length, 1)
  } finally {
    close()
  }
})

// The automatic half of milestone linking: running a cycle while a goal is focused joins it.
test("a workflow started under a focused goal becomes one of its milestones", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    const workflowId = workflow(ctx, "execution")

    assert.equal(linkStartedWorkflow(ctx, workflowId, "add the durable session table"), goal.goalId)
    const current = status(ctx, goal.goalId) as GoalStatus
    assert.equal(current.state, "active")
    assert.equal(current.milestones.length, 1)
    assert.equal(current.milestones[0]?.name, "add the durable session table")
    assert.equal(current.milestones[0]?.state, "active")
    assert.equal(current.milestones[0]?.workflowId, workflowId)
  } finally {
    close()
  }
})

test("nothing is linked when no goal is focused or the focused one is finished", () => {
  const { close, ctx } = fixture()
  try {
    assert.equal(linkStartedWorkflow(ctx, workflow(ctx, "execution"), "a change"), null)

    const goal = create(ctx)
    abort(ctx, goal.goalId, true)
    assert.equal(linkStartedWorkflow(ctx, workflow(ctx, "execution"), "a change"), null)
  } finally {
    close()
  }
})

test("a goal from another project is invisible", () => {
  const { close, ctx } = fixture()
  try {
    const goal = create(ctx)
    const other: GoalContext = { ...ctx, projectId: "p2" }

    assert.deepEqual(status(other, goal.goalId), { found: false })
    assert.deepEqual((goals(other) as { goals: unknown[] }).goals, [])
    assert.throws(() => amend(other, goal.goalId, "mine now"), /another project/u)
  } finally {
    close()
  }
})

// The automatic continuation: delivering a milestone spends one, and running out blocks the goal.
test("a delivered milestone continues its goal until the budget runs out", () => {
  const { close, ctx } = fixture()
  try {
    const goal = newGoal(ctx, {
      maxContinuations: 2,
      objective: OBJECTIVE,
      successCriteria: CRITERIA,
    }) as GoalStatus
    const first = workflow(ctx, "completed")
    const second = workflow(ctx, "completed")
    link(ctx, goal.goalId, "first", first)
    link(ctx, goal.goalId, "second", second)

    assert.deepEqual(advanceGoalOfWorkflow(ctx, first), { blocked: false, goalId: goal.goalId })
    assert.deepEqual(advanceGoalOfWorkflow(ctx, second), { blocked: true, goalId: goal.goalId })
    assert.equal((status(ctx, goal.goalId) as GoalStatus).state, "blocked")
  } finally {
    close()
  }
})

test("a workflow that belongs to no goal continues nothing", () => {
  const { close, ctx } = fixture()
  try {
    assert.equal(advanceGoalOfWorkflow(ctx, workflow(ctx, "completed")), null)

    const goal = create(ctx)
    const workflowId = workflow(ctx, "completed")
    link(ctx, goal.goalId, "the work", workflowId)
    pause(ctx, goal.goalId)

    assert.equal(advanceGoalOfWorkflow(ctx, workflowId), null, "a paused goal does not continue")
  } finally {
    close()
  }
})
