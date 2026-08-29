export function recordEvidence(database, candidateId, evidence, blocking) {
    database.transaction(() => {
        for (const item of evidence) {
            database.run(`insert into evidence (
           id, candidate_id, gate_name, kind, status, mandatory, invocation,
           exit_code, skip_reason, started_at, finished_at, output, output_digest
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (candidate_id, gate_name) do update set
           id = excluded.id, kind = excluded.kind, status = excluded.status,
           mandatory = excluded.mandatory, invocation = excluded.invocation,
           exit_code = excluded.exit_code, skip_reason = excluded.skip_reason,
           started_at = excluded.started_at, finished_at = excluded.finished_at,
           output = excluded.output, output_digest = excluded.output_digest`, item.id, candidateId, item.gate.name, item.gate.kind, item.status, blocking(item) ? 1 : 0, item.gate.invocation, item.exitCode, item.skipReason, item.startedAt, item.finishedAt, item.output, item.outputDigest);
        }
    });
}
export function loadEvidence(database, candidateId) {
    return database
        .all("select id, gate_name, kind, status, mandatory, skip_reason from evidence where candidate_id = ? order by gate_name", candidateId)
        .map((row) => ({
        gateName: String(row["gate_name"]),
        id: String(row["id"]),
        kind: String(row["kind"]),
        mandatory: Number(row["mandatory"]) === 1,
        skipReason: row["skip_reason"] ?? null,
        status: String(row["status"]),
    }));
}
