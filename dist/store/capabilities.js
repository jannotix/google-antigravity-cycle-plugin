import { randomBytes } from "node:crypto";
import { DIGEST_DOMAIN, digest } from "./ids.js";
export const CAPTURING_ROLES = ["functional_reviewer", "security_reviewer"];
export function issueCaptureCapabilities(database, workflowId, candidateId, now) {
    const issued = [];
    for (const role of CAPTURING_ROLES) {
        const existing = database.get("select digest from capture_capabilities where candidate_id = ? and role = ?", candidateId, role);
        if (existing !== undefined)
            continue;
        const token = randomBytes(24).toString("base64url");
        database.run(`insert into capture_capabilities (digest, workflow_id, candidate_id, role, issued_at)
       values (?, ?, ?, ?, ?)`, digest(DIGEST_DOMAIN.captureCapability, token), workflowId, candidateId, role, now);
        issued.push({ role, token });
    }
    return issued;
}
export function redeemCaptureCapability(database, candidateId, token, now) {
    const row = database.get("select candidate_id, consumed_at, role from capture_capabilities where digest = ?", digest(DIGEST_DOMAIN.captureCapability, token));
    if (row === undefined)
        return { reason: "unknown", role: null };
    if (String(row["candidate_id"]) !== candidateId)
        return { reason: "wrong_candidate", role: null };
    if (row["consumed_at"] !== null)
        return { reason: "consumed", role: null };
    database.run("update capture_capabilities set consumed_at = ? where digest = ?", now, digest(DIGEST_DOMAIN.captureCapability, token));
    return { reason: null, role: row["role"] };
}
