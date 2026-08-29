import { addMilestone, amendGoal, createGoal, focusedGoal, focusGoal, goalMilestones, goalOfWorkflow, goalPlans, listGoals, loadGoal, saveGoalPlan, saveGoalState, } from "./store/goals.js";
export class GoalRefused extends Error {
    constructor(message) {
        super(message);
        this.name = "GoalRefused";
    }
}
export const DEFAULT_MAX_CONTINUATIONS = 5;
const MAX_TEXT = 8_000;
const MAX_ITEMS = 50;
const TERMINAL = ["aborted", "completed"];
export function newGoal(context, input, now = Date.now()) {
    const objective = text(input.objective, "objective");
    const successCriteria = list(input.successCriteria, "success criteria");
    if (successCriteria.length === 0) {
        throw new GoalRefused("a goal needs at least one success criterion: completion is judged against it, and a goal " +
            "nobody can judge is a wish");
    }
    const maxContinuations = input.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
    if (!Number.isInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > 50) {
        throw new GoalRefused("continuations must be an integer between 1 and 50");
    }
    const id = createGoal(context.database, context.projectId, {
        constraints: list(input.constraints ?? [], "constraints"),
        maxContinuations,
        nonGoals: list(input.nonGoals ?? [], "non-goals"),
        objective,
        successCriteria,
    }, now);
    focusGoal(context.database, context.projectId, id, now);
    return status(context, id);
}
export function goals(context) {
    return {
        goals: listGoals(context.database, context.projectId).map((goal) => ({
            focused: goal.focused,
            id: goal.id,
            milestones: goalMilestones(context.database, goal.id).length,
            objective: goal.objective,
            state: goal.state,
        })),
    };
}
export function focus(context, id, now = Date.now()) {
    const goal = require(context, id);
    if (TERMINAL.includes(goal.state)) {
        throw new GoalRefused(`a ${goal.state} goal cannot be focused`);
    }
    focusGoal(context.database, context.projectId, id, now);
    return status(context, id);
}
export function plan(context, id, content, sessionId = null, now = Date.now()) {
    const goal = require(context, id);
    if (TERMINAL.includes(goal.state))
        throw new GoalRefused(`a ${goal.state} goal cannot be planned`);
    const version = saveGoalPlan(context.database, id, text(content, "plan"), sessionId, now);
    if (goal.state === "draft" || goal.state === "planning") {
        saveGoalState(context.database, id, "ready", {}, now);
    }
    return { ...status(context, id), version };
}
export function amend(context, id, clarification, now = Date.now()) {
    const goal = require(context, id);
    if (TERMINAL.includes(goal.state))
        throw new GoalRefused(`a ${goal.state} goal cannot be amended`);
    const amendment = amendGoal(context.database, id, text(clarification, "clarification"), now);
    return { ...status(context, id), amendment };
}
export function link(context, id, name, workflowId, now = Date.now()) {
    const goal = require(context, id);
    if (TERMINAL.includes(goal.state))
        throw new GoalRefused(`a ${goal.state} goal cannot take milestones`);
    if (workflowId !== null) {
        const owner = context.database.get("select project_id from workflows where id = ?", workflowId);
        if (owner === undefined)
            throw new GoalRefused(`unknown workflow: ${workflowId}`);
        if (owner.project_id !== context.projectId) {
            throw new GoalRefused("that workflow belongs to another project");
        }
    }
    addMilestone(context.database, id, text(name, "milestone name"), workflowId, now);
    if (workflowId !== null && (goal.state === "ready" || goal.state === "planning" || goal.state === "draft")) {
        saveGoalState(context.database, id, "active", {}, now);
    }
    return status(context, id);
}
export function advance(context, id, now = Date.now()) {
    const goal = require(context, id);
    if (goal.state !== "active")
        throw new GoalRefused(`only an active goal continues, not a ${goal.state} one`);
    const continuations = goal.continuations + 1;
    if (continuations >= goal.maxContinuations) {
        saveGoalState(context.database, id, "blocked", { blockedFrom: goal.state, continuations }, now);
    }
    else {
        saveGoalState(context.database, id, "active", { continuations }, now);
    }
    return status(context, id);
}
export function extend(context, id, additional, now = Date.now()) {
    const goal = require(context, id);
    if (goal.state !== "blocked")
        throw new GoalRefused(`only a blocked goal is extended, not a ${goal.state} one`);
    if (!Number.isInteger(additional) || additional < 1) {
        throw new GoalRefused("additional continuations must be at least one");
    }
    saveGoalState(context.database, id, "active", { blockedFrom: null, maxContinuations: goal.maxContinuations + additional }, now);
    return status(context, id);
}
export function pause(context, id, now = Date.now()) {
    const goal = require(context, id);
    if (TERMINAL.includes(goal.state) || goal.state === "paused") {
        throw new GoalRefused(`a ${goal.state} goal cannot be paused`);
    }
    saveGoalState(context.database, id, "paused", { pausedFrom: goal.state }, now);
    return status(context, id);
}
export function resume(context, id, now = Date.now()) {
    const goal = require(context, id);
    if (goal.state !== "paused" || goal.pausedFrom === null) {
        throw new GoalRefused(`only a paused goal resumes, not a ${goal.state} one`);
    }
    saveGoalState(context.database, id, goal.pausedFrom, { pausedFrom: null }, now);
    return status(context, id);
}
export function abort(context, id, confirmed, now = Date.now()) {
    const goal = require(context, id);
    if (!confirmed)
        throw new GoalRefused("aborting a goal requires explicit confirmation");
    if (TERMINAL.includes(goal.state))
        throw new GoalRefused(`this goal is already ${goal.state}`);
    saveGoalState(context.database, id, "aborted", {}, now);
    return status(context, id);
}
export function requestCompletion(context, id, now = Date.now()) {
    const goal = require(context, id);
    if (TERMINAL.includes(goal.state))
        throw new GoalRefused(`this goal is already ${goal.state}`);
    const milestones = goalMilestones(context.database, id);
    if (milestones.length === 0) {
        throw new GoalRefused("this goal has no milestones, so there is nothing to complete");
    }
    const incomplete = milestones.filter((milestone) => milestone.state !== "completed");
    if (incomplete.length > 0) {
        throw new GoalRefused(`completion refused: ${incomplete.length} milestones are not complete — ${describe(incomplete)}`);
    }
    saveGoalState(context.database, id, "completing", {}, now);
    return {
        ...status(context, id),
        awaiting: "explicit approval",
        judgeAgainst: goal.successCriteria,
    };
}
export function approveCompletion(context, id, confirmed, now = Date.now()) {
    const goal = require(context, id);
    if (goal.state !== "completing") {
        throw new GoalRefused(`completion is approved only after it is requested; this goal is ${goal.state}`);
    }
    if (!confirmed)
        throw new GoalRefused("completing a goal requires explicit confirmation");
    const incomplete = goalMilestones(context.database, id).filter((milestone) => milestone.state !== "completed");
    if (incomplete.length > 0) {
        saveGoalState(context.database, id, "active", {}, now);
        throw new GoalRefused(`a milestone stopped being complete since completion was requested: ${describe(incomplete)}`);
    }
    saveGoalState(context.database, id, "completed", {}, now);
    return status(context, id);
}
export function advanceGoalOfWorkflow(context, workflowId, now = Date.now()) {
    const goalId = goalOfWorkflow(context.database, workflowId);
    if (goalId === undefined)
        return null;
    const goal = loadGoal(context.database, goalId);
    if (goal === undefined || goal.projectId !== context.projectId || goal.state !== "active")
        return null;
    const advanced = advance(context, goalId, now);
    return { blocked: advanced.state === "blocked", goalId };
}
export function status(context, id) {
    const goal = id === undefined ? focusedGoal(context.database, context.projectId) : loadGoal(context.database, id);
    if (goal === undefined || goal.projectId !== context.projectId) {
        return { found: false };
    }
    const milestones = goalMilestones(context.database, goal.id);
    const plans = goalPlans(context.database, goal.id);
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
    };
}
export function currentPlan(context, id) {
    require(context, id);
    const plans = goalPlans(context.database, id);
    return { current: plans.at(-1) ?? null, versions: plans.map((entry) => entry.version) };
}
export function linkStartedWorkflow(context, workflowId, request, now = Date.now()) {
    const goal = focusedGoal(context.database, context.projectId);
    if (goal === undefined)
        return null;
    if (goal.state !== "active" && goal.state !== "ready" && goal.state !== "planning" && goal.state !== "draft") {
        return null;
    }
    const name = subjectOf(request);
    addMilestone(context.database, goal.id, name, workflowId, now);
    if (goal.state !== "active")
        saveGoalState(context.database, goal.id, "active", {}, now);
    return goal.id;
}
function describe(milestones) {
    return milestones
        .slice(0, 5)
        .map((milestone) => `${milestone.name} (${milestone.state})`)
        .join(", ");
}
function require(context, id) {
    const goal = loadGoal(context.database, id);
    if (goal === undefined)
        throw new GoalRefused(`unknown goal: ${id}`);
    if (goal.projectId !== context.projectId)
        throw new GoalRefused("that goal belongs to another project");
    return goal;
}
function subjectOf(request) {
    const first = request.trim().split(/\r?\n/u)[0]?.trim() ?? "milestone";
    return (first.length > 120 ? `${first.slice(0, 117)}...` : first) || "milestone";
}
function text(value, field) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
        throw new GoalRefused(`${field} must be non-empty text of at most ${MAX_TEXT} characters`);
    }
    return value.trim();
}
function list(value, field) {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) {
        throw new GoalRefused(`${field} must be an array of at most ${MAX_ITEMS} entries`);
    }
    return value.map((entry) => text(entry, `${field} entry`));
}
