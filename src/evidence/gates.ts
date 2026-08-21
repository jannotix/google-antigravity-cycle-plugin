import { newId } from "../store/ids.ts"
import type { SafeCommand } from "../workflow/commands.ts"
import { outputDigest } from "./digest.ts"

export type GateKind =
  | "browser"
  | "build"
  | "command"
  | "database"
  | "inspection"
  | "lint"
  | "package"
  | "security"
  | "test"

export type GateStatus = "failed" | "passed" | "skipped" | "warning"

/**
 * Everything a gate can do. `unavailable` is not an error state: it is the executor of a gate the
 * project does not supply, and it fails by construction so a missing proof cannot read as a passing
 * one.
 */
export type GateExecutor =
  | { readonly command: SafeCommand; readonly kind: "command" }
  | { readonly kind: "candidate-integrity" }
  | { readonly kind: "design" }
  | { readonly kind: "essentiality" }
  | { readonly kind: "secret-scan" }
  | { readonly kind: "unavailable"; readonly reason: string }

export interface Gate {
  readonly executor: GateExecutor
  readonly invocation: string
  readonly kind: GateKind
  readonly mandatory: boolean
  /** Why this gate is in the set: read by reviewers, and by the user when a gate fails. */
  readonly precondition: string
  readonly name: string
  readonly timeoutSeconds: number
}

export interface Evidence {
  readonly exitCode: number | null
  readonly finishedAt: number
  readonly gate: Gate
  readonly id: string
  readonly output: string
  readonly outputDigest: string
  readonly skipReason: string | null
  readonly startedAt: number
  readonly status: GateStatus
}

/** What the engine reports back to the state machine, and the only thing it may act on. */
export interface VerificationOutcome {
  readonly evidenceIds: readonly string[]
  readonly mandatoryPassed: boolean
  readonly reason: string
}

// Per-gate timeouts arrive with the plan field that carries them; every gate uses this until then.
export const DEFAULT_TIMEOUT_SECONDS = 600

/** One evidence record for one gate. The digest covers the gate name as well as its output. */
export function evidenceFor(
  gate: Gate,
  startedAt: number,
  status: GateStatus,
  extra: { output?: string; skipReason?: string } = {},
): Evidence {
  const output = extra.output ?? ""
  return {
    exitCode: null,
    finishedAt: Date.now(),
    gate,
    id: newId(),
    output,
    outputDigest: outputDigest(`${gate.name}::${output}`),
    skipReason: extra.skipReason ?? null,
    startedAt,
    status,
  }
}
