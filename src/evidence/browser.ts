import { inspectAccessibility, type Snapshot } from "./accessibility.ts"
import type { DesignFinding } from "./design.ts"
import { renderFindings } from "./engine.ts"
import { DEFAULT_TIMEOUT_SECONDS, evidenceFor, type Evidence, type Gate } from "./gates.ts"

const FLOW: Gate = {
  executor: { kind: "design" },
  invocation: "",
  kind: "browser",
  mandatory: true,
  name: "browser:affected-user-flow",
  precondition: "the affected user flow was driven in the browser and its tree captured",
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
}

const ACCESSIBILITY: Gate = {
  executor: { kind: "design" },
  invocation: "",
  kind: "browser",
  mandatory: true,
  name: "accessibility:affected-user-flow",
  precondition: "the captured accessibility tree was inspected by deterministic detectors",
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
}

export interface BrowserEvidence {
  readonly evidence: readonly Evidence[]
  readonly findings: readonly DesignFinding[]
}

/**
 * Turns one captured browser flow into the two pieces of evidence the interface layer requires: the
 * flow was actually driven, and the tree it produced was inspected.
 *
 * A high finding — a control with no accessible name — fails the accessibility gate, because a
 * control a screen reader cannot announce is not shipped work. Medium and low findings are recorded
 * in the same evidence for the reviewers to weigh without blocking the candidate on them.
 */
export function browserEvidence(snapshot: Snapshot, now = Date.now()): BrowserEvidence {
  const findings = inspectAccessibility(snapshot)
  const blocking = findings.filter((finding) => finding.severity === "high")
  const nodes = countNodes(snapshot)

  return {
    evidence: [
      evidenceFor(FLOW, now, "passed", {
        output: `flow "${snapshot.capturedFlow}" driven at ${snapshot.url}, ${nodes} accessibility nodes captured`,
      }),
      evidenceFor(ACCESSIBILITY, now, blocking.length === 0 ? "passed" : "failed", {
        output: renderFindings(`${nodes} accessibility nodes inspected`, findings),
      }),
    ],
    findings,
  }
}

function countNodes(snapshot: Snapshot): number {
  const count = (nodes: Snapshot["nodes"]): number =>
    nodes.reduce((total, node) => total + 1 + count(node.children), 0)
  return count(snapshot.nodes)
}
