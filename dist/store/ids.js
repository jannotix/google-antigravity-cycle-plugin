import { createHash, randomUUID } from "node:crypto";
export const DIGEST_DOMAIN = {
    candidate: "cycle/candidate/v1",
    captureCapability: "cycle/capture-capability/v1",
    goal: "cycle/goal-objective/v1",
    historyEntry: "cycle/history-entry/v1",
    output: "cycle/verification-output/v1",
    request: "cycle/request/v1",
    requestAmendment: "cycle/request-amendment/v1",
    verdict: "cycle/verdict/v1",
};
export function newId() {
    return randomUUID();
}
export function digest(domain, value) {
    const payload = Buffer.from(canonicalJson(value), "utf8");
    return createHash("sha256")
        .update(Buffer.from(domain, "utf8"))
        .update(lengthPrefix(payload.byteLength))
        .update(payload)
        .digest("hex");
}
export function digestBytes(domain, bytes) {
    return createHash("sha256")
        .update(Buffer.from(domain, "utf8"))
        .update(lengthPrefix(bytes.byteLength))
        .update(bytes)
        .digest("hex");
}
export function canonicalJson(value) {
    return JSON.stringify(value, (_key, nested) => {
        if (nested === null || typeof nested !== "object" || Array.isArray(nested))
            return nested;
        return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }) ?? "null";
}
function lengthPrefix(length) {
    const prefix = Buffer.allocUnsafe(8);
    prefix.writeBigUInt64BE(BigInt(length));
    return prefix;
}
