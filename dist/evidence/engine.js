import { findSecrets } from "../secrets.js";
import { loadEvidence, recordEvidence } from "../store/evidence.js";
import { newId } from "../store/ids.js";
import { frozenFiles } from "../store/workflows.js";
import { changedFiles, readChangedContent } from "./changes.js";
import { inspectDesign, isInterfaceFile } from "./design.js";
import { discoverGates } from "./discovery.js";
import { reimplementedCapabilities } from "./essentiality.js";
import { DEFAULT_TIMEOUT_SECONDS, evidenceFor, } from "./gates.js";
import { requiredMissingGates } from "./required.js";
import { runCommand } from "./runner.js";
const INTEGRITY = {
    executor: { kind: "candidate-integrity" },
    invocation: "",
    kind: "inspection",
    mandatory: true,
    name: "integrity:candidate",
    precondition: "every candidate is compared against the bytes recorded when it was frozen",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};
const SECRET_SCAN = {
    executor: { kind: "secret-scan" },
    invocation: "",
    kind: "security",
    mandatory: true,
    name: "security:changed-content-secrets",
    precondition: "every candidate's changed content is scanned before it can be reviewed",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};
const DESIGN = {
    executor: { kind: "design" },
    invocation: "",
    kind: "inspection",
    mandatory: false,
    name: "design:detectors",
    precondition: "changed interface files are inspected by deterministic detectors",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};
const ESSENTIALITY = {
    executor: { kind: "essentiality" },
    invocation: "",
    kind: "inspection",
    mandatory: false,
    name: "essentiality:reimplementation",
    precondition: "added definitions are checked against the code graph for an existing equivalent",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};
export async function verify(input) {
    const changed = await changedFiles(input.root);
    const results = [];
    results.push(integrity(input, changed));
    const present = changed ?? [];
    results.push(await secretScan(input.root, present));
    results.push(essentiality(input, present));
    results.push(await design(input.root, present));
    const recorded = loadEvidence(input.database, input.candidateId).map((item) => item.gateName);
    const discovered = await discoverGates(input.root, input.taskCommands);
    const gates = [
        ...discovered.gates,
        ...requiredMissingGates(present, discovered.gates, input.strictness, recorded),
    ];
    for (const gate of gates)
        results.push(await execute(gate, input));
    const blocking = (item) => item.gate.mandatory && (item.status !== "skipped" || input.strictness === "strict");
    recordEvidence(input.database, input.candidateId, results, blocking);
    const stored = loadEvidence(input.database, input.candidateId);
    const mandatory = stored.filter((item) => item.mandatory);
    const failed = mandatory.filter((item) => item.status !== "passed");
    return {
        evidenceIds: stored.map((item) => item.id),
        mandatoryPassed: mandatory.length > 0 && failed.length === 0,
        reason: describe(mandatory.length, failed.map((item) => item.gateName)),
    };
}
function describe(mandatory, failed) {
    if (mandatory === 0)
        return "no mandatory gate ran, so nothing has been verified";
    if (failed.length === 0)
        return `${mandatory} mandatory gates passed`;
    return `${failed.length} of ${mandatory} mandatory gates did not pass: ${failed.join(", ")}`;
}
async function design(root, changed) {
    const startedAt = Date.now();
    const files = [];
    for (const file of changed) {
        if (file.kind === "deleted" || !isInterfaceFile(file.path))
            continue;
        const content = await readChangedContent(root, file.path);
        if (content !== null)
            files.push({ content, path: file.path });
    }
    const findings = inspectDesign(files);
    return evidenceFor(DESIGN, startedAt, findings.length === 0 ? "passed" : "failed", {
        output: files.length === 0
            ? "the change touches no interface file"
            : renderFindings(`${files.length} interface files inspected`, findings),
    });
}
export function renderFindings(headline, findings) {
    if (findings.length === 0)
        return `${headline}, no finding`;
    return [
        `${headline}, ${findings.length} findings`,
        ...findings.map((finding) => `${finding.file}:${finding.line} [${finding.severity}] ${finding.rule} — ${finding.summary}`),
    ].join("\n");
}
function integrity(input, changed) {
    const startedAt = Date.now();
    if (changed === null) {
        return evidenceFor(INTEGRITY, startedAt, "failed", {
            output: "the change set could not be determined: git is unavailable or this directory is not a " +
                "repository. An unknown candidate is never a verified one.",
        });
    }
    const frozen = frozenFiles(input.database, input.candidateId);
    if (frozen.length === 0 && changed.length === 0) {
        return evidenceFor(INTEGRITY, startedAt, "failed", {
            output: "the candidate contains no changed files: nothing was implemented",
        });
    }
    const now = new Map(changed.map((file) => [file.path, file.digest]));
    const drifted = frozen.filter((file) => {
        const current = now.get(file.path);
        if (current === undefined || current === null || file.digest === null)
            return true;
        return current !== file.digest;
    });
    const appeared = changed.filter((file) => !frozen.some((entry) => entry.path === file.path));
    if (drifted.length === 0 && appeared.length === 0) {
        return evidenceFor(INTEGRITY, startedAt, "passed", {
            output: `${frozen.length} files match the bytes recorded at freeze`,
        });
    }
    return evidenceFor(INTEGRITY, startedAt, "failed", {
        output: [
            "candidate changed after freeze",
            ...drifted.map((file) => `changed or removed: ${file.path}`),
            ...appeared.map((file) => `appeared after freeze: ${file.path}`),
        ].join("\n"),
    });
}
async function secretScan(root, changed) {
    const startedAt = Date.now();
    const found = [];
    const unread = [];
    let scanned = 0;
    for (const file of changed) {
        if (file.kind === "deleted")
            continue;
        const content = await readChangedContent(root, file.path);
        if (content === null) {
            unread.push(file.path);
            continue;
        }
        scanned += 1;
        for (const match of findSecrets(content))
            found.push(`${file.path}: ${match.rule}`);
    }
    const clean = found.length === 0 && unread.length === 0;
    const lines = [
        ...(found.length === 0 ? [] : ["secrets found in changed content", ...found]),
        ...(unread.length === 0
            ? []
            : [`${unread.length} changed file(s) could not be read and were not scanned:`, ...unread]),
    ];
    return evidenceFor(SECRET_SCAN, startedAt, clean ? "passed" : "failed", {
        output: clean ? `${scanned} changed files scanned, no secret shape found` : lines.join("\n"),
    });
}
function essentiality(input, changed) {
    const startedAt = Date.now();
    const duplicates = reimplementedCapabilities(input.database, input.projectId, changed);
    return evidenceFor(ESSENTIALITY, startedAt, duplicates.length === 0 ? "passed" : "failed", {
        output: duplicates.length === 0
            ? "no added definition duplicates an existing capability"
            : [
                "added code duplicates a capability the project already has",
                ...duplicates.map((entry) => `${entry.kind} ${entry.name}: added in ${entry.addedIn}, already in ${entry.existsIn}`),
            ].join("\n"),
    });
}
async function execute(gate, input) {
    const startedAt = Date.now();
    if (gate.executor.kind === "unavailable") {
        return evidenceFor(gate, startedAt, input.strictness === "advisory" ? "warning" : "failed", {
            output: gate.precondition,
            skipReason: gate.executor.reason,
        });
    }
    if (gate.executor.kind !== "command") {
        return evidenceFor(gate, startedAt, "skipped", { skipReason: "this gate has no runner in this build" });
    }
    const outcome = await runCommand(gate.executor.command, {
        cwd: input.root,
        timeoutSeconds: gate.timeoutSeconds,
    });
    if (outcome.unavailable !== null) {
        return evidenceFor(gate, startedAt, "skipped", {
            output: outcome.unavailable,
            skipReason: outcome.unavailable,
        });
    }
    const status = outcome.timedOut || outcome.exitCode !== 0 ? "failed" : "passed";
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
    };
}
