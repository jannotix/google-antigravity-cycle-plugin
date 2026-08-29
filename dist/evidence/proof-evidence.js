import { newId } from "../store/ids.js";
import { DEFAULT_TIMEOUT_SECONDS, evidenceFor } from "./gates.js";
import { PROOF_TIMEOUT_SECONDS } from "./proof.js";
const CLASS_PATTERN = /^[a-z][a-z0-9-]{2,47}$/u;
export function proofGateName(vulnerabilityClass) {
    const normalized = vulnerabilityClass.trim().toLowerCase().replaceAll(/[\s_]+/gu, "-");
    if (!CLASS_PATTERN.test(normalized)) {
        throw new Error("a vulnerability class is 3 to 48 lowercase letters, digits or hyphens, such as sql-injection");
    }
    return `security:proof:${normalized}`;
}
export function proofEvidence(vulnerabilityClass, rationale, result, startedAt) {
    const gate = {
        executor: { kind: "unavailable", reason: "a proof runs on request, never as part of a sweep" },
        invocation: result.outcome.invocation,
        kind: "security",
        mandatory: result.demonstrated,
        name: proofGateName(vulnerabilityClass),
        precondition: rationale,
        timeoutSeconds: Math.min(PROOF_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    };
    if (result.outcome.unavailable !== null) {
        return evidenceFor(gate, startedAt, "skipped", {
            output: result.outcome.unavailable,
            skipReason: result.outcome.unavailable,
        });
    }
    const header = [
        result.demonstrated
            ? "DEMONSTRATED: the proof exited 0 against a disposable copy of this candidate"
            : `not demonstrated: the proof exited ${result.outcome.exitCode ?? "with no code"}`,
        `rationale: ${rationale}`,
        "containment applied:",
        ...result.containment.map((line) => `  - ${line}`),
        "proof output:",
    ].join("\n");
    return {
        exitCode: result.outcome.exitCode,
        finishedAt: Date.now(),
        gate,
        id: newId(),
        output: `${header}\n${result.outcome.output}`.trim(),
        outputDigest: result.outcome.outputDigest,
        skipReason: null,
        startedAt,
        status: result.demonstrated ? "failed" : "passed",
    };
}
