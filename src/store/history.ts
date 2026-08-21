import type { Role } from "../config.ts"
import { redactSecrets } from "../secrets.ts"
import type { Database, Row } from "./database.ts"
import { DIGEST_DOMAIN, digest } from "./ids.ts"

export interface HistoryEvent {
  readonly action: string
  readonly actor: string
  readonly candidateId?: string | null
  readonly evidenceIds?: readonly string[]
  readonly files?: readonly string[]
  readonly metadata?: Readonly<Record<string, string>>
  readonly projectId: string
  readonly role?: Role | null
  readonly sessionId?: string | null
  readonly workflowId?: string | null
}

export interface HistoryEntry {
  readonly action: string
  readonly actor: string
  readonly candidateId: string | null
  readonly evidenceIds: readonly string[]
  readonly files: readonly string[]
  readonly hash: string
  readonly metadata: Readonly<Record<string, string>>
  readonly previousHash: string | null
  readonly projectId: string
  readonly recordedAt: number
  readonly role: string | null
  readonly sequence: number
  readonly sessionId: string | null
  readonly workflowId: string | null
}

export type ChainVerification =
  | { readonly entries: number; readonly head: string | null; readonly valid: true }
  | { readonly reason: "hash" | "link" | "sequence"; readonly sequence: number; readonly valid: false }

export function appendHistory(
  database: Database,
  event: HistoryEvent,
  recordedAt: number,
): HistoryEntry {
  return database.transaction(() => {
    const head = database.get<{ hash: string; sequence: number }>(
      "select hash, sequence from history order by sequence desc limit 1",
    )
    const sequence = head === undefined ? 0 : head.sequence + 1
    const previousHash = head?.hash ?? null

    const metadata = Object.fromEntries(
      Object.entries(event.metadata ?? {}).map(([key, value]) => [key, redactSecrets(value)]),
    )
    const files = [...(event.files ?? [])]
    const evidenceIds = [...(event.evidenceIds ?? [])]
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
    }
    const hash = chainHash(sequence, previousHash, payload)

    database.run(
      `insert into history (
         sequence, project_id, actor, role, session_id, workflow_id, candidate_id,
         action, event, files, evidence_ids, recorded_at, previous_hash, hash
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sequence,
      event.projectId,
      event.actor,
      event.role ?? null,
      event.sessionId ?? null,
      event.workflowId ?? null,
      event.candidateId ?? null,
      event.action,
      JSON.stringify(payload),
      JSON.stringify(files),
      JSON.stringify(evidenceIds),
      recordedAt,
      previousHash,
      hash,
    )

    return { ...payload, hash, previousHash, sequence }
  })
}

export function readHistory(
  database: Database,
  projectId: string,
  afterSequence: number | null,
  limit: number,
): HistoryEntry[] {
  const rows = database.all<Row>(
    `select * from history
     where project_id = ? and sequence > ?
     order by sequence
     limit ?`,
    projectId,
    afterSequence ?? -1,
    limit,
  )
  return rows.map(toEntry)
}

/**
 * The most recent entry of one action for one workflow. The columns narrow the search, but every
 * field is read back from the hashed payload and re-checked against what was asked for, so a
 * rewritten column can hide an entry and never invent one.
 */
export function lastEvent(
  database: Database,
  workflowId: string,
  action: string,
): HistoryEntry | undefined {
  const row = database.get<Row>(
    "select * from history where workflow_id = ? and action = ? order by sequence desc limit 1",
    workflowId,
    action,
  )
  if (row === undefined) return undefined
  const entry = toEntry(row)
  return entry.workflowId === workflowId && entry.action === action ? entry : undefined
}

/**
 * Walks the whole chain rather than a project slice: a gap anywhere invalidates every hash after it,
 * so a per-project view could report a tampered chain as intact.
 */
export function verifyHistory(database: Database): ChainVerification {
  const rows = database.all<Row>("select * from history order by sequence")
  let previousHash: string | null = null

  for (const [index, row] of rows.entries()) {
    const entry = toEntry(row)
    if (entry.sequence !== index) {
      return { reason: "sequence", sequence: index, valid: false }
    }
    if (entry.previousHash !== previousHash) {
      return { reason: "link", sequence: entry.sequence, valid: false }
    }

    const payload: unknown = JSON.parse(String(row["event"]))
    if (chainHash(entry.sequence, previousHash, payload) !== entry.hash) {
      return { reason: "hash", sequence: entry.sequence, valid: false }
    }
    previousHash = entry.hash
  }

  return { entries: rows.length, head: previousHash, valid: true }
}

function chainHash(sequence: number, previousHash: string | null, payload: unknown): string {
  return digest(DIGEST_DOMAIN.historyEntry, { payload, previousHash, sequence })
}

/**
 * Every field is read back from the hashed payload, never from the denormalized columns. Those
 * columns exist only so the chain can be filtered and indexed; rewriting one must not change what a
 * reader sees, or tampering would be invisible to verification.
 */
function toEntry(row: Row): HistoryEntry {
  const payload = JSON.parse(String(row["event"])) as Partial<HistoryEntry> & {
    metadata?: Record<string, string>
  }
  return {
    action: payload.action ?? "",
    actor: payload.actor ?? "",
    candidateId: payload.candidateId ?? null,
    evidenceIds: payload.evidenceIds ?? [],
    files: payload.files ?? [],
    hash: String(row["hash"]),
    metadata: payload.metadata ?? {},
    previousHash: (row["previous_hash"] as string | null) ?? null,
    projectId: payload.projectId ?? "",
    recordedAt: payload.recordedAt ?? 0,
    role: payload.role ?? null,
    sequence: Number(row["sequence"]),
    sessionId: payload.sessionId ?? null,
    workflowId: payload.workflowId ?? null,
  }
}
