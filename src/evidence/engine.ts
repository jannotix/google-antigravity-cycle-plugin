import type { GateStrictness } from "../config.ts"
import { findSecrets } from "../secrets.ts"
import type { Database } from "../store/database.ts"
import { loadEvidence, recordEvidence } from "../store/evidence.ts"
import { newId } from "../store/ids.ts"
import { frozenFiles } from "../store/workflows.ts"
import { changedFiles, readChangedContent, type ChangedFile } from "./changes.ts"
import { inspectDesign, isInterfaceFile, type DesignFinding } from "./design.ts"
import { discoverGates } from "./discovery.ts"
import { reimplementedCapabilities } from "./essentiality.ts"
import {
  DEFAULT_TIMEOUT_SECONDS,
  evidenceFor,
  type Evidence,
  type Gate,
  type GateStatus,
  type VerificationOutcome,
} from "./gates.ts"
import { requiredMissingGates } from "./required.ts"
import { runCommand } from "./runner.ts"

export interface VerificationInput {
  readonly candidateId: string
  readonly database: Database
  readonly projectId: string
  readonly root: string
  readonly strictness: GateStrictness
  readonly taskCommands: readonly string[]
}

const INTEGRITY: Gate = {
  executor: { kind: "candidate-integrity" },
  invocation: "",
  kind: "inspection",
  mandatory: true,
  name: "integrity:candidate",
  precondition: "every candidate is compared against the bytes recorded when it was frozen",
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
}

const SECRET_SCAN: Gate = {
  executor: { kind: "secret-scan" },
  invocation: "",
  kind: "security",
  mandatory: true,
  name: "security:changed-content-secrets",
  precondition: "every candidate's changed content is scanned before it can be reviewed",
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
}

const DESIGN: Gate = {
  executor: { kind: "design" },
  invocation: "",
  kind: "inspection",
  // Findings, not a refusal: the detectors say what is wrong and the reviewers weigh it. They run
  // over bytes, so they cost no tokens and need no key.
  mandatory: false,
  name: "design:detectors",
  precondition: "changed interface files are inspected by deterministic detectors",
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
}

const ESSENTIALITY: Gate = {
  executor: { kind: "essentiality" },
  invocation: "",
  kind: "inspection",
  // A finding for the functional reviewer to score, not a refusal: reuse is a judgement about the
  // change, and the reviewer is the one who makes it.
  mandatory: false,
  name: "essentiality:reimplementation",
  precondition: "added definitions are checked against the code graph for an existing equivalent",
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
}

/**
 * Runs every gate this candidate must satisfy and records each result as evidence. The outcome is
 * derived from what was recorded, never from what a role reported: an agent's claim of success is
 * not evidence.
 */
export async function verify(input: VerificationInput): Promise<VerificationOutcome> {
  const changed = await changedFiles(input.root)
  const results: Evidence[] = []

  results.push(integrity(input, changed))

  const present = changed ?? []
  results.push(await secretScan(input.root, present))
  results.push(essentiality(input, present))
  results.push(await design(input.root, present))

  // Evidence submitted before verification — a browser attestation with its accessibility tree —
  // already supplies the layer it covers, so the missing-gate for that layer is not inserted.
  const recorded = loadEvidence(input.database, input.candidateId).map((item) => item.gateName)
  const discovered = await discoverGates(input.root, input.taskCommands)
  const gates = [
    ...discovered.gates,
    ...requiredMissingGates(present, discovered.gates, input.strictness, recorded),
  ]

  for (const gate of gates) results.push(await execute(gate, input))

  // Under strict, a gate that could not run is a gate that did not pass. Under standard it is
  // recorded and does not block, because the project not having a tool installed is not a defect in
  // the change. Under advisory a required-missing gate is a warning by construction.
  const blocking = (item: Evidence): boolean =>
    item.gate.mandatory && (item.status !== "skipped" || input.strictness === "strict")

  recordEvidence(input.database, input.candidateId, results, blocking)

  // Derived from the table, not from what just ran: evidence submitted earlier in this candidate's
  // life counts exactly as much as evidence produced now, and arbitration reads the same rows.
  const stored = loadEvidence(input.database, input.candidateId)
  const mandatory = stored.filter((item) => item.mandatory)
  const failed = mandatory.filter((item) => item.status !== "passed")

  return {
    evidenceIds: stored.map((item) => item.id),
    mandatoryPassed: mandatory.length > 0 && failed.length === 0,
    reason: describe(mandatory.length, failed.map((item) => item.gateName)),
  }
}

function describe(mandatory: number, failed: readonly string[]): string {
  if (mandatory === 0) return "no mandatory gate ran, so nothing has been verified"
  if (failed.length === 0) return `${mandatory} mandatory gates passed`
  return `${failed.length} of ${mandatory} mandatory gates did not pass: ${failed.join(", ")}`
}

async function design(root: string, changed: readonly ChangedFile[]): Promise<Evidence> {
  const startedAt = Date.now()
  const files: { content: string; path: string }[] = []

  for (const file of changed) {
    if (file.kind === "deleted" || !isInterfaceFile(file.path)) continue
    const content = await readChangedContent(root, file.path)
    if (content !== null) files.push({ content, path: file.path })
  }

  const findings = inspectDesign(files)
  return evidenceFor(DESIGN, startedAt, findings.length === 0 ? "passed" : "failed", {
    output:
      files.length === 0
        ? "the change touches no interface file"
        : renderFindings(`${files.length} interface files inspected`, findings),
  })
}

export function renderFindings(headline: string, findings: readonly DesignFinding[]): string {
  if (findings.length === 0) return `${headline}, no finding`
  return [
    `${headline}, ${findings.length} findings`,
    ...findings.map(
      (finding) =>
        `${finding.file}:${finding.line} [${finding.severity}] ${finding.rule} — ${finding.summary}`,
    ),
  ].join("\n")
}

function integrity(
  input: VerificationInput,
  changed: readonly ChangedFile[] | null,
): Evidence {
  const startedAt = Date.now()

  if (changed === null) {
    return evidenceFor(INTEGRITY, startedAt, "failed", {
      output:
        "the change set could not be determined: git is unavailable or this directory is not a " +
        "repository. An unknown candidate is never a verified one.",
    })
  }

  const frozen = frozenFiles(input.database, input.candidateId)
  if (frozen.length === 0 && changed.length === 0) {
    // An executor that changed nothing has produced nothing to review. Passing an empty candidate
    // is the exact false "done" this product exists to refuse.
    return evidenceFor(INTEGRITY, startedAt, "failed", {
      output: "the candidate contains no changed files: nothing was implemented",
    })
  }

  const now = new Map(changed.map((file) => [file.path, file.digest]))
  const drifted = frozen.filter((file) => now.get(file.path) !== file.digest)
  const appeared = changed.filter((file) => !frozen.some((entry) => entry.path === file.path))

  if (drifted.length === 0 && appeared.length === 0) {
    return evidenceFor(INTEGRITY, startedAt, "passed", {
      output: `${frozen.length} files match the bytes recorded at freeze`,
    })
  }

  return evidenceFor(INTEGRITY, startedAt, "failed", {
    output: [
      "candidate changed after freeze",
      ...drifted.map((file) => `changed or removed: ${file.path}`),
      ...appeared.map((file) => `appeared after freeze: ${file.path}`),
    ].join("\n"),
  })
}

async function secretScan(root: string, changed: readonly ChangedFile[]): Promise<Evidence> {
  const startedAt = Date.now()
  const found: string[] = []

  for (const file of changed) {
    if (file.kind === "deleted") continue
    const content = await readChangedContent(root, file.path)
    if (content === null) continue
    for (const match of findSecrets(content)) found.push(`${file.path}: ${match.rule}`)
  }

  return evidenceFor(SECRET_SCAN, startedAt, found.length === 0 ? "passed" : "failed", {
    // The matched text is never echoed: recording a secret to prove it was found would publish it.
    output:
      found.length === 0
        ? `${changed.length} changed files scanned, no secret shape found`
        : ["secrets found in changed content", ...found].join("\n"),
  })
}

function essentiality(input: VerificationInput, changed: readonly ChangedFile[]): Evidence {
  const startedAt = Date.now()
  const duplicates = reimplementedCapabilities(input.database, input.projectId, changed)

  return evidenceFor(ESSENTIALITY, startedAt, duplicates.length === 0 ? "passed" : "failed", {
    output:
      duplicates.length === 0
        ? "no added definition duplicates an existing capability"
        : [
            "added code duplicates a capability the project already has",
            ...duplicates.map(
              (entry) => `${entry.kind} ${entry.name}: added in ${entry.addedIn}, already in ${entry.existsIn}`,
            ),
          ].join("\n"),
  })
}

async function execute(gate: Gate, input: VerificationInput): Promise<Evidence> {
  const startedAt = Date.now()

  if (gate.executor.kind === "unavailable") {
    // A required-missing gate. Its unavailability is the result, not an obstacle to producing one.
    return evidenceFor(gate, startedAt, input.strictness === "advisory" ? "warning" : "failed", {
      output: gate.precondition,
      skipReason: gate.executor.reason,
    })
  }
  if (gate.executor.kind !== "command") {
    return evidenceFor(gate, startedAt, "skipped", { skipReason: "this gate has no runner in this build" })
  }

  const outcome = await runCommand(gate.executor.command, {
    cwd: input.root,
    timeoutSeconds: gate.timeoutSeconds,
  })

  if (outcome.unavailable !== null) {
    return evidenceFor(gate, startedAt, "skipped", {
      output: outcome.unavailable,
      skipReason: outcome.unavailable,
    })
  }

  const status: GateStatus = outcome.timedOut || outcome.exitCode !== 0 ? "failed" : "passed"
  return {
    exitCode: outcome.exitCode,
    finishedAt: Date.now(),
    gate: { ...gate, invocation: outcome.invocation },
    id: newId(),
    output: outcome.timedOut
      ? `${outcome.output}\ngate exceeded ${gate.timeoutSeconds}s and was terminated`.trim()
      : outcome.output,
    outputDigest: outcome.outputDigest,
    skipReason: null,
    startedAt,
    status,
  }
}


export type { VerificationOutcome }
