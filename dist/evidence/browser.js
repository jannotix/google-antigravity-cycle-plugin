import { inspectAccessibility } from "./accessibility.js";
import { renderFindings } from "./engine.js";
import { DEFAULT_TIMEOUT_SECONDS, evidenceFor } from "./gates.js";
const FLOW = {
    executor: { kind: "design" },
    invocation: "",
    kind: "browser",
    mandatory: true,
    name: "browser:affected-user-flow",
    precondition: "the affected user flow was driven in the browser and its tree captured",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};
const ACCESSIBILITY = {
    executor: { kind: "design" },
    invocation: "",
    kind: "browser",
    mandatory: true,
    name: "accessibility:affected-user-flow",
    precondition: "the captured accessibility tree was inspected by deterministic detectors",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};
const REPORTED_FLOW = {
    ...FLOW,
    mandatory: false,
    name: "browser:executor-report",
    precondition: "the executor reported driving the affected user flow; nothing independent confirms it",
};
const REPORTED_ACCESSIBILITY = {
    ...ACCESSIBILITY,
    mandatory: false,
    name: "accessibility:executor-report",
    precondition: "detectors ran over a tree the executor supplied, which nothing independent confirms",
};
export function browserEvidence(snapshot, capturedBy, now = Date.now()) {
    const findings = inspectAccessibility(snapshot);
    const blocking = findings.filter((finding) => finding.severity === "high");
    const nodes = countNodes(snapshot);
    const independent = capturedBy !== "executor";
    const summary = independent
        ? `flow "${snapshot.capturedFlow}" driven at ${snapshot.url} by the ${capturedBy.replace("_", " ")}, ${nodes} accessibility nodes captured`
        : `flow "${snapshot.capturedFlow}" reported at ${snapshot.url} by the executor, ${nodes} accessibility nodes. Self-reported: recorded for the reviewers, and it does not satisfy the interface layer.`;
    return {
        evidence: [
            evidenceFor(independent ? FLOW : REPORTED_FLOW, now, independent ? "passed" : "warning", {
                output: summary,
            }),
            evidenceFor(independent ? ACCESSIBILITY : REPORTED_ACCESSIBILITY, now, blocking.length === 0 ? (independent ? "passed" : "warning") : "failed", { output: renderFindings(`${nodes} accessibility nodes inspected`, findings) }),
        ],
        findings,
    };
}
function countNodes(snapshot) {
    const count = (nodes) => nodes.reduce((total, node) => total + 1 + count(node.children), 0);
    return count(snapshot.nodes);
}
