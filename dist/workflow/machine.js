export class TransitionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "TransitionError";
    }
}
const TERMINAL = ["cancelled", "completed"];
const UNPAUSABLE = [
    "blocked",
    "cancelled",
    "completed",
    "delivery",
    "paused",
    "verification",
];
export function newWorkflow(maxRepairCycles) {
    return {
        blockedFrom: null,
        candidateId: null,
        maxRepairCycles,
        mode: null,
        pausedFrom: null,
        repairCycles: 0,
        repairTarget: null,
        state: "intake",
    };
}
export function isTerminal(state) {
    return TERMINAL.includes(state);
}
export function apply(workflow, command) {
    const { state } = workflow;
    switch (command.type) {
        case "complete_intake":
            return at(workflow, "intake", { state: "routing" });
        case "route":
            return at(workflow, "routing", {
                mode: command.mode,
                state: command.mode === "quick" ? "quick_execution" : "architecture",
            });
        case "architecture_accepted":
            return at(workflow, "architecture", { state: "execution" });
        case "candidate_ready":
            if (state !== "execution" && state !== "quick_execution")
                throw invalid(command.type, state);
            return { ...workflow, candidateId: command.candidateId, state: "verification" };
        case "verification_passed": {
            requireIn(state, ["verification"], command.type);
            requireCandidate(workflow);
            if (workflow.mode === null)
                throw invalid(command.type, state);
            return {
                ...workflow,
                state: workflow.mode === "full" ? "independent_reviews" : "arbitration",
            };
        }
        case "verification_failed":
            requireIn(state, ["verification"], command.type);
            requireCandidate(workflow);
            return reject(workflow, command.target);
        case "execution_failed":
            requireIn(state, ["execution", "quick_execution"], command.type);
            return reject(workflow, command.target);
        case "reviews_ready":
            return at(workflow, "independent_reviews", { state: "arbitration" });
        case "approve": {
            requireIn(state, ["arbitration"], command.type);
            requireCandidate(workflow);
            if (!command.mandatoryGatesPassed) {
                throw new TransitionError("gates_not_passed", "approval refused: mandatory verification gates have not passed");
            }
            return { ...workflow, state: "delivery" };
        }
        case "deliver":
            requireIn(state, ["delivery"], command.type);
            requireCandidate(workflow);
            return { ...workflow, state: "completed" };
        case "reject":
            requireIn(state, ["arbitration"], command.type);
            requireCandidate(workflow);
            return reject(workflow, command.target);
        case "begin_repair": {
            requireIn(state, ["repair"], command.type);
            const target = workflow.repairTarget;
            if (target === null) {
                throw new TransitionError("no_repair_target", "the workflow has no repair target");
            }
            return {
                ...workflow,
                candidateId: null,
                repairTarget: null,
                state: target === "architecture" ? "architecture" : "execution",
            };
        }
        case "replan":
            return at(workflow, "execution", { state: "architecture" });
        case "pause":
            if (UNPAUSABLE.includes(state))
                throw invalid(command.type, state);
            return { ...workflow, pausedFrom: state, state: "paused" };
        case "resume": {
            requireIn(state, ["paused"], command.type);
            const previous = workflow.pausedFrom;
            if (previous === null)
                throw invalid(command.type, state);
            return { ...workflow, pausedFrom: null, state: previous };
        }
        case "resume_blocked": {
            requireIn(state, ["blocked"], command.type);
            if (!Number.isInteger(command.additionalCycles) || command.additionalCycles < 1) {
                throw new TransitionError("out_of_range", "additional repair cycles must be at least one");
            }
            return {
                ...workflow,
                blockedFrom: null,
                maxRepairCycles: workflow.maxRepairCycles + command.additionalCycles,
                state: "repair",
            };
        }
        case "cancel":
            if (isTerminal(state))
                throw invalid(command.type, state);
            return { ...workflow, pausedFrom: null, state: "cancelled" };
        default:
            throw invalid(command.type, state);
    }
}
function reject(workflow, target) {
    const repairCycles = workflow.repairCycles + 1;
    const exhausted = repairCycles >= workflow.maxRepairCycles;
    return {
        ...workflow,
        blockedFrom: exhausted ? workflow.state : workflow.blockedFrom,
        repairCycles,
        repairTarget: target,
        state: exhausted ? "blocked" : "repair",
    };
}
function at(workflow, from, next) {
    requireIn(workflow.state, [from], "transition");
    return { ...workflow, ...next };
}
function requireIn(state, allowed, command) {
    if (!allowed.includes(state))
        throw invalid(command, state);
}
function requireCandidate(workflow) {
    if (workflow.candidateId === null) {
        throw new TransitionError("no_candidate", "the workflow has no current candidate");
    }
}
function invalid(command, state) {
    return new TransitionError("invalid_transition", `${command} is not valid while the workflow is in ${state}`);
}
