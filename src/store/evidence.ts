import type { Evidence } from "../evidence/gates.ts"
import type { Database, Row } from "./database.ts"

export interface StoredEvidence {
  readonly gateName: string
  readonly id: string
  readonly kind: string
  readonly mandatory: boolean
  readonly skipReason: string | null
  readonly status: string
}

/**
 * One row per gate per candidate. The unique key is (candidate, gate), so a re-run replaces its own
 * record rather than accumulating a history in which the reviewer can pick the flattering one.
 */
export function recordEvidence(
  database: Database,
  candidateId: string,
  evidence: readonly Evidence[],
  blocking: (item: Evidence) => boolean,
): void {
  database.transaction(() => {
    for (const item of evidence) {
      database.run(
        `insert into evidence (
           id, candidate_id, gate_name, kind, status, mandatory, invocation,
           exit_code, skip_reason, started_at, finished_at, output, output_digest
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (candidate_id, gate_name) do update set
           id = excluded.id, kind = excluded.kind, status = excluded.status,
           mandatory = excluded.mandatory, invocation = excluded.invocation,
           exit_code = excluded.exit_code, skip_reason = excluded.skip_reason,
           started_at = excluded.started_at, finished_at = excluded.finished_at,
           output = excluded.output, output_digest = excluded.output_digest`,
        item.id,
        candidateId,
        item.gate.name,
        item.gate.kind,
        item.status,
        blocking(item) ? 1 : 0,
        item.gate.invocation,
        item.exitCode,
        item.skipReason,
        item.startedAt,
        item.finishedAt,
        item.output,
        item.outputDigest,
      )
    }
  })
}

export function loadEvidence(database: Database, candidateId: string): StoredEvidence[] {
  return database
    .all<Row>(
      "select id, gate_name, kind, status, mandatory, skip_reason from evidence where candidate_id = ? order by gate_name",
      candidateId,
    )
    .map((row) => ({
      gateName: String(row["gate_name"]),
      id: String(row["id"]),
      kind: String(row["kind"]),
      mandatory: Number(row["mandatory"]) === 1,
      skipReason: (row["skip_reason"] as string | null) ?? null,
      status: String(row["status"]),
    }))
}
