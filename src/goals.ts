import type { Database } from "./store/database.ts"
import {
  addMilestone,
  amendGoal,
  createGoal,
  focusedGoal,
  focusGoal,
  goalMilestones,
  goalOfWorkflow,
  goalPlans,
  listGoals,
  loadGoal,
  saveGoalPlan,
  saveGoalState,
  type Goal,
  type GoalState,
  type Milestone,
} from "./store/goals.ts"

export interface GoalContext {
  readonly database: Database
  readonly projectId: string
}

export class GoalRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GoalRefused"
  }
}

export const DEFAULT_MAX_CONTINUATIONS = 5

const MAX_TEXT = 8_000
const MAX_ITEMS = 50
const TERMINAL: readonly GoalState[] = ["aborted", "completed"]

/**
 * A goal sits above individual workflows and survives sessions. It starts as a draft: the objective
 * is fixed from this moment and every later clarification is an appended amendment, because a goal
 * whose objective can be edited cannot be judged against what was actually asked for.
 */
export function newGoal(
  context: GoalContext,
  input: {
    constraints?: readonly string[]
    maxContinuations?: number
    nonGoals?: readonly string[]
    objective: string
    successCriteria: readonly string[]
  },
  now = Date.now(),
): unknown {
  const objective = text(input.objective, "objective")
  const successCriteria = list(input.successCriteria, "success criteria")
  if (successCriteria.length === 0) {
    throw new GoalRefused(
      "a goal needs at least one success criterion: completion is judged against it, and a goal " +
        "nobody can judge is a wish",
    )
  }

  const maxContinuations = input.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > 50) {
    throw new GoalRefused("continuations must be an integer between 1 and 50")
  }

  const id = createGoal(
    context.database,
    context.projectId,
    {
      constraints: list(input.constraints ?? [], "constraints"),
      maxContinuations,
      nonGoals: list(input.nonGoals ?? [], "non-goals"),
      objective,
      successCriteria,
    },
    now,
  )
  focusGoal(context.database, context.projectId, id, now)
  return status(context, id)
}

export function goals(context: GoalContext): unknown {
  return {
    goals: listGoals(context.database, context.projectId).map((goal) => ({
      focused: goal.focused,
      id: goal.id,
      milestones: goalMilestones(context.database, goal.id).length,
      objective: goal.objective,
      state: goal.state,
    })),
  }
}

export function focus(context: GoalContext, id: string, now = Date.now()): unknown {
  const goal = require(context, id)
  if (TERMINAL.includes(goal.state)) {
    throw new GoalRefused(`a ${goal.state} goal cannot be focused`)
  }
  focusGoal(context.database, context.projectId, id, now)
  return status(context, id)
}

/** A versioned plan. Superseding one keeps the previous version: goals change their minds. */
export function plan(
  context: GoalContext,
  id: string,
  content: string,
  sessionId: string | null = null,
  now = Date.now(),
): unknown {
  const goal = require(context, id)
  if (TERMINAL.includes(goal.state)) throw new GoalRefused(`a ${goal.state} goal cannot be planned`)

  const version = saveGoalPlan(context.database, id, text(content, "plan"), sessionId, now)
  if (goal.state === "draft" || goal.state === "planning") {
    saveGoalState(context.database, id, "ready", {}, now)
  }
  return { ...(status(context, id) as object), version }
}

export function amend(context: GoalContext, id: string, clarification: string, now = Date.now()): unknown {
  const goal = require(context, id)
  if (TERMINAL.includes(goal.state)) throw new GoalRefused(`a ${goal.state} goal cannot be amended`)

  const amendment = amendGoal(context.database, id, text(clarification, "clarification"), now)
  return { ...(status(context, id) as object), amendment }
}

/**
 * Each implementation milestone is a normal evidence-gated workflow: the goal links to it, and the
 * workflow's own state is what the milestone reports. Linking is what moves a goal into `active`.
 */
export function link(
  context: GoalContext,
  id: string,
  name: string,
  workflowId: string | null,
  now = Date.now(),
): unknown {
  const goal = require(context, id)
  if (TERMINAL.includes(goal.state)) throw new GoalRefused(`a ${goal.state} goal cannot take milestones`)

  if (workflowId !== null) {
    const owner = context.database.get<{ project_id: string }>(
      "select project_id from workflows where id = ?",
      workflowId,
    )
    if (owner === undefined) throw new GoalRefused(`unknown workflow: ${workflowId}`)
    if (owner.project_id !== context.projectId) {
      throw new GoalRefused("that workflow belongs to another project")
    }
  }

  addMilestone(context.database, id, text(name, "milestone name"), workflowId, now)
  if (workflowId !== null && (goal.state === "ready" || goal.state === "planning" || goal.state === "draft")) {
    saveGoalState(context.database, id, "active", {}, now)
  }
  return status(context, id)
}

/**
 * Advancing past a completed milestone spends a continuation. The budget is what stops a goal from
 * running by itself indefinitely; exhausting it blocks, which preserves everything and can be
 * extended deliberately — the same shape as the repair budget, for the same reason.
 */
export function advance(context: GoalContext, id: string, now = Date.now()): unknown {
  const goal = require(context, id)
  if (goal.state !== "active") throw new GoalRefused(`only an active goal continues, not a ${goal.state} one`)

  const continuations = goal.continuations + 1
  if (continuations >= goal.maxContinuations) {
    saveGoalState(
      context.database,
      id,
      "blocked",
      { blockedFrom: goal.state, continuations },
      now,
    )
  } else {
    saveGoalState(context.database, id, "active", { continuations }, now)
  }
  return status(context, id)
}

export function extend(context: GoalContext, id: string, additional: number, now = Date.now()): unknown {
  const goal = require(context, id)
  if (goal.state !== "blocked") throw new GoalRefused(`only a blocked goal is extended, not a ${goal.state} one`)
  if (!Number.isInteger(additional) || additional < 1) {
    throw new GoalRefused("additional continuations must be at least one")
  }

  saveGoalState(
    context.database,
    id,
    "active",
    { blockedFrom: null, maxContinuations: goal.maxContinuations + additional },
    now,
  )
  return status(context, id)
}

export function pause(context: GoalContext, id: string, now = Date.now()): unknown {
  const goal = require(context, id)
  if (TERMINAL.includes(goal.state) || goal.state === "paused") {
    throw new GoalRefused(`a ${goal.state} goal cannot be paused`)
  }
  saveGoalState(context.database, id, "paused", { pausedFrom: goal.state }, now)
  return status(context, id)
}

export function resume(context: GoalContext, id: string, now = Date.now()): unknown {
  const goal = require(context, id)
  if (goal.state !== "paused" || goal.pausedFrom === null) {
    throw new GoalRefused(`only a paused goal resumes, not a ${goal.state} one`)
  }
  saveGoalState(context.database, id, goal.pausedFrom, { pausedFrom: null }, now)
  return status(context, id)
}

export function abort(context: GoalContext, id: string, confirmed: boolean, now = Date.now()): unknown {
  const goal = require(context, id)
  if (!confirmed) throw new GoalRefused("aborting a goal requires explicit confirmation")
  if (TERMINAL.includes(goal.state)) throw new GoalRefused(`this goal is already ${goal.state}`)

  saveGoalState(context.database, id, "aborted", {}, now)
  return status(context, id)
}

/**
 * The completion gate, first half. A goal cannot reach `completed` while any linked workflow is
 * incomplete, and a goal that never linked one has not achieved anything to complete.
 */
export function requestCompletion(context: GoalContext, id: string, now = Date.now()): unknown {
  const goal = require(context, id)
  if (TERMINAL.includes(goal.state)) throw new GoalRefused(`this goal is already ${goal.state}`)

  const milestones = goalMilestones(context.database, id)
  if (milestones.length === 0) {
    throw new GoalRefused("this goal has no milestones, so there is nothing to complete")
  }

  const incomplete = milestones.filter((milestone) => milestone.state !== "completed")
  if (incomplete.length > 0) {
    throw new GoalRefused(
      `completion refused: ${incomplete.length} milestones are not complete — ${describe(incomplete)}`,
    )
  }

  saveGoalState(context.database, id, "completing", {}, now)
  return {
    ...(status(context, id) as object),
    awaiting: "explicit approval",
    judgeAgainst: goal.successCriteria,
  }
}

/** The second half: a person says so. Nothing else completes a goal. */
export function approveCompletion(
  context: GoalContext,
  id: string,
  confirmed: boolean,
  now = Date.now(),
): unknown {
  const goal = require(context, id)
  if (goal.state !== "completing") {
    throw new GoalRefused(
      `completion is approved only after it is requested; this goal is ${goal.state}`,
    )
  }
  if (!confirmed) throw new GoalRefused("completing a goal requires explicit confirmation")

  const incomplete = goalMilestones(context.database, id).filter(
    (milestone) => milestone.state !== "completed",
  )
  if (incomplete.length > 0) {
    // Between the request and the approval a milestone can be reopened. The gate is checked again
    // rather than trusted from a moment ago.
    saveGoalState(context.database, id, "active", {}, now)
    throw new GoalRefused(`a milestone stopped being complete since completion was requested: ${describe(incomplete)}`)
  }

  saveGoalState(context.database, id, "completed", {}, now)
  return status(context, id)
}


/**
 * A delivered milestone continues the goal it belongs to, spending one continuation. This is the
 * automatic half of Goal Mode: nobody has to remember to advance it, and the budget still bounds how
 * far it goes on its own.
 */
export function advanceGoalOfWorkflow(
  context: GoalContext,
  workflowId: string,
  now = Date.now(),
): { blocked: boolean; goalId: string } | null {
  const goalId = goalOfWorkflow(context.database, workflowId)
  if (goalId === undefined) return null

  const goal = loadGoal(context.database, goalId)
  if (goal === undefined || goal.projectId !== context.projectId || goal.state !== "active") return null

  const advanced = advance(context, goalId, now) as { state: string }
  return { blocked: advanced.state === "blocked", goalId }
}

export function status(context: GoalContext, id?: string): unknown {
  const goal =
    id === undefined ? focusedGoal(context.database, context.projectId) : loadGoal(context.database, id)
  if (goal === undefined || goal.projectId !== context.projectId) {
    return { found: false }
  }

  const milestones = goalMilestones(context.database, goal.id)
  const plans = goalPlans(context.database, goal.id)
  return {
    amendments: goal.amendments,
    constraints: goal.constraints,
    continuations: { max: goal.maxContinuations, used: goal.continuations },
    focused: goal.focused,
    found: true,
    goalId: goal.id,
    milestones,
    nonGoals: goal.nonGoals,
    objective: goal.objective,
    objectiveDigest: goal.objectiveDigest,
    planVersion: plans.at(-1)?.version ?? null,
    remaining: milestones.filter((milestone) => milestone.state !== "completed").length,
    state: goal.state,
    successCriteria: goal.successCriteria,
  }
}

export function currentPlan(context: GoalContext, id: string): unknown {
  require(context, id)
  const plans = goalPlans(context.database, id)
  return { current: plans.at(-1) ?? null, versions: plans.map((entry) => entry.version) }
}

/**
 * Called when a workflow starts: if a goal is focused and running, the workflow becomes one of its
 * milestones without anybody having to remember to link it.
 */
export function linkStartedWorkflow(
  context: GoalContext,
  workflowId: string,
  request: string,
  now = Date.now(),
): string | null {
  const goal = focusedGoal(context.database, context.projectId)
  if (goal === undefined) return null
  if (goal.state !== "active" && goal.state !== "ready" && goal.state !== "planning" && goal.state !== "draft") {
    return null
  }

  const name = subjectOf(request)
  addMilestone(context.database, goal.id, name, workflowId, now)
  if (goal.state !== "active") saveGoalState(context.database, goal.id, "active", {}, now)
  return goal.id
}

function describe(milestones: readonly Milestone[]): string {
  return milestones
    .slice(0, 5)
    .map((milestone) => `${milestone.name} (${milestone.state})`)
    .join(", ")
}

function require(context: GoalContext, id: string): Goal {
  const goal = loadGoal(context.database, id)
  if (goal === undefined) throw new GoalRefused(`unknown goal: ${id}`)
  if (goal.projectId !== context.projectId) throw new GoalRefused("that goal belongs to another project")
  return goal
}

function subjectOf(request: string): string {
  const first = request.trim().split(/\r?\n/u)[0]?.trim() ?? "milestone"
  return (first.length > 120 ? `${first.slice(0, 117)}...` : first) || "milestone"
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new GoalRefused(`${field} must be non-empty text of at most ${MAX_TEXT} characters`)
  }
  return value.trim()
}

function list(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new GoalRefused(`${field} must be an array of at most ${MAX_ITEMS} entries`)
  }
  return value.map((entry) => text(entry, `${field} entry`))
}
