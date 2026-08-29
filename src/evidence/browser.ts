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
 * Who drove the flow. The executor cannot certify its own work: a capture it supplies is a report
 * about what it says it did, and the control plane has no way to tell a real tree from an invented
 * one. So a self-reported capture is recorded under its own gate names, carries no mandatory
 * weight, and does not satisfy the interface layer the change requires. A reviewer that drives the
 * flow itself supplies evidence, because the party producing it is not the party being gated.
 */
export type CapturedBy = "executor" | "functional_reviewer" | "security_reviewer"

const REPORTED_FLOW: Gate = {
  ...FLOW,
  mandatory: false,
  name: "browser:executor-report",
  precondition: "the executor reported driving the affected user flow; nothing independent confirms it",
}

const REPORTED_ACCESSIBILITY: Gate = {
  ...ACCESSIBILITY,
  mandatory: false,
  name: "accessibility:executor-report",
  precondition: "detectors ran over a tree the executor supplied, which nothing independent confirms",
}

/**
 * Turns one captured browser flow into the two pieces of evidence the interface layer requires: the
 * flow was actually driven, and the tree it produced was inspected.
 *
 * A high finding — a control with no accessible name — fails the accessibility gate, because a
 * control a screen reader cannot announce is not shipped work. Medium and low findings are recorded
 * in the same evidence for the reviewers to weigh without blocking the candidate on them.
 */
export function browserEvidence(
  snapshot: Snapshot,
  capturedBy: CapturedBy,
  now = Date.now(),
): BrowserEvidence {
  const findings = inspectAccessibility(snapshot)
  const blocking = findings.filter((finding) => finding.severity === "high")
  const nodes = countNodes(snapshot)
  const independent = capturedBy !== "executor"

  const summary = independent
    ? `flow "${snapshot.capturedFlow}" driven at ${snapshot.url} by the ${capturedBy.replace("_", " ")}, ${nodes} accessibility nodes captured`
    : `flow "${snapshot.capturedFlow}" reported at ${snapshot.url} by the executor, ${nodes} accessibility nodes. Self-reported: recorded for the reviewers, and it does not satisfy the interface layer.`

  return {
    evidence: [
      evidenceFor(independent ? FLOW : REPORTED_FLOW, now, independent ? "passed" : "warning", {
        output: summary,
      }),
      evidenceFor(
        independent ? ACCESSIBILITY : REPORTED_ACCESSIBILITY,
        now,
        blocking.length === 0 ? (independent ? "passed" : "warning") : "failed",
        { output: renderFindings(`${nodes} accessibility nodes inspected`, findings) },
      ),
    ],
    findings,
  }
}

function countNodes(snapshot: Snapshot): number {
  const count = (nodes: Snapshot["nodes"]): number =>
    nodes.reduce((total, node) => total + 1 + count(node.children), 0)
  return count(snapshot.nodes)
}
