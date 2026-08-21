export type WorkflowState =
  | "arbitration"
  | "architecture"
  | "blocked"
  | "cancelled"
  | "completed"
  | "delivery"
  | "execution"
  | "independent_reviews"
  | "intake"
  | "paused"
  | "quick_execution"
  | "repair"
  | "routing"
  | "verification"

export type WorkflowMode = "full" | "quick"
export type RepairTarget = "architecture" | "execution"

export type WorkflowCommand =
  | { readonly type: "approve"; readonly mandatoryGatesPassed: boolean }
  | { readonly type: "architecture_accepted" }
  | { readonly type: "begin_repair" }
  | { readonly type: "cancel" }
  | { readonly type: "candidate_ready"; readonly candidateId: string }
  | { readonly type: "complete_intake" }
  | { readonly type: "deliver" }
  | { readonly target: RepairTarget; readonly type: "execution_failed" }
  | { readonly type: "pause" }
  | { readonly type: "reject"; readonly target: RepairTarget }
  | { readonly type: "replan" }
  | { readonly type: "resume" }
  | { readonly type: "resume_blocked"; readonly additionalCycles: number }
  | { readonly type: "reviews_ready" }
  | { readonly type: "route"; readonly mode: WorkflowMode }
  | { readonly type: "verification_failed"; readonly target: RepairTarget }
  | { readonly type: "verification_passed" }

export interface Workflow {
  readonly blockedFrom: WorkflowState | null
  readonly candidateId: string | null
  readonly maxRepairCycles: number
  readonly mode: WorkflowMode | null
  readonly pausedFrom: WorkflowState | null
  readonly repairCycles: number
  readonly repairTarget: RepairTarget | null
  readonly state: WorkflowState
}

export type TransitionErrorCode =
  | "gates_not_passed"
  | "invalid_transition"
  | "no_candidate"
  | "no_repair_target"
  | "out_of_range"

export class TransitionError extends Error {
  readonly code: TransitionErrorCode

  constructor(code: TransitionErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "TransitionError"
  }
}

const TERMINAL: readonly WorkflowState[] = ["cancelled", "completed"]

const UNPAUSABLE: readonly WorkflowState[] = [
  "blocked",
  "cancelled",
  "completed",
  "delivery",
  "paused",
  "verification",
]

export function newWorkflow(maxRepairCycles: number): Workflow {
  return {
    blockedFrom: null,
    candidateId: null,
    maxRepairCycles,
    mode: null,
    pausedFrom: null,
    repairCycles: 0,
    repairTarget: null,
    state: "intake",
  }
}

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL.includes(state)
}

export function apply(workflow: Workflow, command: WorkflowCommand): Workflow {
  const { state } = workflow

  switch (command.type) {
    case "complete_intake":
      return at(workflow, "intake", { state: "routing" })

    case "route":
      return at(workflow, "routing", {
        mode: command.mode,
        state: command.mode === "quick" ? "quick_execution" : "architecture",
      })

    case "architecture_accepted":
      return at(workflow, "architecture", { state: "execution" })

    case "candidate_ready":
      if (state !== "execution" && state !== "quick_execution") throw invalid(command.type, state)
      return { ...workflow, candidateId: command.candidateId, state: "verification" }

    case "verification_passed": {
      requireIn(state, ["verification"], command.type)
      requireCandidate(workflow)
      if (workflow.mode === null) throw invalid(command.type, state)
      return {
        ...workflow,
        state: workflow.mode === "full" ? "independent_reviews" : "arbitration",
      }
    }

    case "verification_failed":
      requireIn(state, ["verification"], command.type)
      requireCandidate(workflow)
      return reject(workflow, command.target)

    // Execution can fail before there is anything to freeze: a task the executor could not finish,
    // or one that wrote where no scope authorized it. It costs a repair cycle exactly like a
    // rejection does, and requires no candidate, because that is the point — there is none.
    case "execution_failed":
      requireIn(state, ["execution", "quick_execution"], command.type)
      return reject(workflow, command.target)

    case "reviews_ready":
      return at(workflow, "independent_reviews", { state: "arbitration" })

    case "approve": {
      requireIn(state, ["arbitration"], command.type)
      requireCandidate(workflow)
      // The single most important refusal in the product: an arbiter's approval does not deliver
      // anything unless the mandatory gates actually passed.
      if (!command.mandatoryGatesPassed) {
        throw new TransitionError(
          "gates_not_passed",
          "approval refused: mandatory verification gates have not passed",
        )
      }
      return { ...workflow, state: "delivery" }
    }

    case "deliver":
      requireIn(state, ["delivery"], command.type)
      requireCandidate(workflow)
      return { ...workflow, state: "completed" }

    case "reject":
      requireIn(state, ["arbitration"], command.type)
      requireCandidate(workflow)
      return reject(workflow, command.target)

    case "begin_repair": {
      requireIn(state, ["repair"], command.type)
      const target = workflow.repairTarget
      if (target === null) {
        throw new TransitionError("no_repair_target", "the workflow has no repair target")
      }
      return {
        ...workflow,
        candidateId: null,
        repairTarget: null,
        state: target === "architecture" ? "architecture" : "execution",
      }
    }

    case "replan":
      return at(workflow, "execution", { state: "architecture" })

    case "pause":
      if (UNPAUSABLE.includes(state)) throw invalid(command.type, state)
      return { ...workflow, pausedFrom: state, state: "paused" }

    case "resume": {
      requireIn(state, ["paused"], command.type)
      const previous = workflow.pausedFrom
      if (previous === null) throw invalid(command.type, state)
      return { ...workflow, pausedFrom: null, state: previous }
    }

    case "resume_blocked": {
      requireIn(state, ["blocked"], command.type)
      if (!Number.isInteger(command.additionalCycles) || command.additionalCycles < 1) {
        throw new TransitionError("out_of_range", "additional repair cycles must be at least one")
      }
      return {
        ...workflow,
        blockedFrom: null,
        maxRepairCycles: workflow.maxRepairCycles + command.additionalCycles,
        state: "repair",
      }
    }

    case "cancel":
      if (isTerminal(state)) throw invalid(command.type, state)
      return { ...workflow, pausedFrom: null, state: "cancelled" }

    default:
      throw invalid((command as { type: string }).type, state)
  }
}

/** Consumes a repair cycle and blocks when the budget is exhausted, preserving all state. */
function reject(workflow: Workflow, target: RepairTarget): Workflow {
  const repairCycles = workflow.repairCycles + 1
  const exhausted = repairCycles >= workflow.maxRepairCycles
  return {
    ...workflow,
    blockedFrom: exhausted ? workflow.state : workflow.blockedFrom,
    repairCycles,
    repairTarget: target,
    state: exhausted ? "blocked" : "repair",
  }
}

function at(workflow: Workflow, from: WorkflowState, next: Partial<Workflow>): Workflow {
  requireIn(workflow.state, [from], "transition")
  return { ...workflow, ...next }
}

function requireIn(state: WorkflowState, allowed: readonly WorkflowState[], command: string): void {
  if (!allowed.includes(state)) throw invalid(command, state)
}

function requireCandidate(workflow: Workflow): void {
  if (workflow.candidateId === null) {
    throw new TransitionError("no_candidate", "the workflow has no current candidate")
  }
}

function invalid(command: string, state: WorkflowState): TransitionError {
  return new TransitionError(
    "invalid_transition",
    `${command} is not valid while the workflow is in ${state}`,
  )
}
