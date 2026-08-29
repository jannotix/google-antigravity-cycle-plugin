export const UNATTRIBUTED = {
    candidateId: null,
    eventSequence: null,
    evidenceIds: [],
    revision: null,
    role: null,
    sessionId: null,
};
export function provenance(partial = {}) {
    return { ...UNATTRIBUTED, ...partial };
}
export function serializeProvenance(value) {
    return JSON.stringify(value);
}
export function parseProvenance(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return UNATTRIBUTED;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return UNATTRIBUTED;
    const record = parsed;
    return {
        candidateId: text(record["candidateId"]),
        eventSequence: integer(record["eventSequence"]),
        evidenceIds: strings(record["evidenceIds"]),
        revision: text(record["revision"]),
        role: text(record["role"]),
        sessionId: text(record["sessionId"]),
    };
}
export function isAttributed(value) {
    return (value.candidateId !== null ||
        value.eventSequence !== null ||
        value.evidenceIds.length > 0 ||
        value.revision !== null);
}
function text(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function integer(value) {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function strings(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
