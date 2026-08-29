import { loadEvidence } from "./store/evidence.js";
import { currentMemoryOfKind, insertMemory, memoriesInScope, memoryChain, readMemory, revokeMemory, searchMemory, supersedeMemory, } from "./store/memory.js";
import { provenance } from "./store/provenance.js";
const RECALL_LIMIT = 12;
const GATE_MEMORY_TITLE = "verification gates that pass in this project";
const MAX_DETAIL = 4_000;
export function captureDelivery(context, work, now = Date.now()) {
    const evidence = loadEvidence(context.database, work.candidateId);
    const passed = evidence.filter((item) => item.status === "passed");
    if (passed.length === 0)
        return [];
    const written = [];
    const scope = scopeOf(work.files);
    const source = provenance({
        candidateId: work.candidateId,
        evidenceIds: passed.map((item) => item.id),
        revision: work.revision,
    });
    written.push(insertMemory(context.database, {
        confidence: "verified",
        detail: bounded([
            `Delivered at ${work.revision}.`,
            "",
            "Files:",
            ...work.files.map((file) => `  ${file}`),
            "",
            "Gates that passed:",
            ...passed.map((item) => `  ${item.gateName}`),
        ].join("\n")),
        kind: "approval",
        projectId: context.projectId,
        provenance: source,
        scope,
        summary: `${work.files.length} files delivered at ${work.revision.slice(0, 12)} on ${passed.length} recorded gates`,
        title: subjectOf(work.request),
    }, now));
    const gates = gateMemory(context, passed, source, work.revision, now);
    if (gates !== null)
        written.push(gates);
    return written;
}
function gateMemory(context, passed, source, revision, now) {
    const names = [...new Set(passed.map((item) => item.gateName))].sort();
    if (names.length === 0)
        return null;
    const input = {
        confidence: "verified",
        detail: bounded(["Gates recorded as passing:", ...names.map((name) => `  ${name}`)].join("\n")),
        kind: "command",
        projectId: context.projectId,
        provenance: source,
        scope: ["."],
        summary: `${names.length} gates verified this project as of ${revision.slice(0, 12)}`,
        title: GATE_MEMORY_TITLE,
    };
    const previous = currentMemoryOfKind(context.database, context.projectId, "command", GATE_MEMORY_TITLE);
    return previous === undefined
        ? insertMemory(context.database, input, now)
        : supersedeMemory(context.database, previous, input, now);
}
export function captureBlocked(context, work, now = Date.now()) {
    const evidence = loadEvidence(context.database, work.candidateId);
    const failed = evidence.filter((item) => item.status !== "passed");
    if (failed.length === 0)
        return null;
    return insertMemory(context.database, {
        confidence: "inferred",
        detail: bounded([
            `Blocked after ${work.cycles} repair cycles.`,
            "",
            "Gates that did not pass:",
            ...failed.map((item) => `  ${item.gateName}: ${item.status}${item.skipReason === null ? "" : ` — ${item.skipReason}`}`),
            "",
            "Files the attempt touched:",
            ...work.files.map((file) => `  ${file}`),
        ].join("\n")),
        kind: "failed_approach",
        projectId: context.projectId,
        provenance: provenance({
            candidateId: work.candidateId,
            evidenceIds: failed.map((item) => item.id),
        }),
        scope: scopeOf(work.files),
        summary: `blocked after ${work.cycles} repair cycles on ${failed.map((item) => item.gateName).join(", ")}`,
        title: subjectOf(work.request),
    }, now);
}
export function recall(context, request, paths = [], limit = RECALL_LIMIT) {
    const found = new Map();
    for (const entry of searchMemory(context.database, context.projectId, request, limit)) {
        found.set(entry.id, entry);
    }
    for (const entry of memoriesInScope(context.database, context.projectId, paths, limit)) {
        if (found.size >= limit)
            break;
        found.set(entry.id, entry);
    }
    return [...found.values()].slice(0, limit);
}
export function explain(context, ids) {
    return readMemory(context.database, ids.slice(0, 20)).filter((entry) => entry.projectId === context.projectId);
}
export function forget(context, id, now = Date.now()) {
    const owned = explain(context, [id]).length === 1;
    return {
        chain: memoryChain(context.database, id),
        revoked: owned && revokeMemory(context.database, id, now),
    };
}
export function chainOf(context, id) {
    return memoryChain(context.database, id);
}
function scopeOf(files) {
    const directories = new Set();
    for (const file of files) {
        const normalized = file.replaceAll("\\", "/");
        const cut = normalized.lastIndexOf("/");
        directories.add(cut === -1 ? "." : normalized.slice(0, cut));
    }
    const scope = [...directories].sort().slice(0, 20);
    return scope.length === 0 ? ["."] : scope;
}
function subjectOf(request) {
    const first = request.trim().split(/\r?\n/u)[0]?.trim() ?? "delivered work";
    return first.length > 120 ? `${first.slice(0, 117)}...` : first || "delivered work";
}
function bounded(detail) {
    return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 3)}...` : detail;
}
