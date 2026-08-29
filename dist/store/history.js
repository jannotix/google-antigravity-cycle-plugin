import { redactSecrets } from "../secrets.js";
import { DIGEST_DOMAIN, digest } from "./ids.js";
export function appendHistory(database, event, recordedAt) {
    return database.transaction(() => {
        const head = database.get("select hash, sequence from history order by sequence desc limit 1");
        const sequence = head === undefined ? 0 : head.sequence + 1;
        const previousHash = head?.hash ?? null;
        const metadata = Object.fromEntries(Object.entries(event.metadata ?? {}).map(([key, value]) => [key, redactSecrets(value)]));
        const files = [...(event.files ?? [])];
        const evidenceIds = [...(event.evidenceIds ?? [])];
        const payload = {
            action: event.action,
            actor: event.actor,
            candidateId: event.candidateId ?? null,
            evidenceIds,
            files,
            metadata,
            projectId: event.projectId,
            recordedAt,
            role: event.role ?? null,
            sessionId: event.sessionId ?? null,
            workflowId: event.workflowId ?? null,
        };
        const hash = chainHash(sequence, previousHash, payload);
        database.run(`insert into history (
         sequence, project_id, actor, role, session_id, workflow_id, candidate_id,
         action, event, files, evidence_ids, recorded_at, previous_hash, hash
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sequence, event.projectId, event.actor, event.role ?? null, event.sessionId ?? null, event.workflowId ?? null, event.candidateId ?? null, event.action, JSON.stringify(payload), JSON.stringify(files), JSON.stringify(evidenceIds), recordedAt, previousHash, hash);
        return { ...payload, hash, previousHash, sequence };
    });
}
export function readHistory(database, projectId, afterSequence, limit) {
    const rows = database.all(`select * from history
     where project_id = ? and sequence > ?
     order by sequence
     limit ?`, projectId, afterSequence ?? -1, limit);
    return rows.map(toEntry);
}
export function lastEvent(database, workflowId, action) {
    const row = database.get("select * from history where workflow_id = ? and action = ? order by sequence desc limit 1", workflowId, action);
    if (row === undefined)
        return undefined;
    const entry = toEntry(row);
    return entry.workflowId === workflowId && entry.action === action ? entry : undefined;
}
export function verifyHistory(database) {
    const rows = database.all("select * from history order by sequence");
    let previousHash = null;
    for (const [index, row] of rows.entries()) {
        const entry = toEntry(row);
        if (entry.sequence !== index) {
            return { reason: "sequence", sequence: index, valid: false };
        }
        if (entry.previousHash !== previousHash) {
            return { reason: "link", sequence: entry.sequence, valid: false };
        }
        const payload = JSON.parse(String(row["event"]));
        if (chainHash(entry.sequence, previousHash, payload) !== entry.hash) {
            return { reason: "hash", sequence: entry.sequence, valid: false };
        }
        previousHash = entry.hash;
    }
    return { entries: rows.length, head: previousHash, valid: true };
}
function chainHash(sequence, previousHash, payload) {
    return digest(DIGEST_DOMAIN.historyEntry, { payload, previousHash, sequence });
}
function toEntry(row) {
    const payload = JSON.parse(String(row["event"]));
    return {
        action: payload.action ?? "",
        actor: payload.actor ?? "",
        candidateId: payload.candidateId ?? null,
        evidenceIds: payload.evidenceIds ?? [],
        files: payload.files ?? [],
        hash: String(row["hash"]),
        metadata: payload.metadata ?? {},
        previousHash: row["previous_hash"] ?? null,
        projectId: payload.projectId ?? "",
        recordedAt: payload.recordedAt ?? 0,
        role: payload.role ?? null,
        sequence: Number(row["sequence"]),
        sessionId: payload.sessionId ?? null,
        workflowId: payload.workflowId ?? null,
    };
}
