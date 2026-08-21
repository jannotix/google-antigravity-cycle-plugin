import { containsSecret } from "../secrets.ts"
import type { Database, Row } from "./database.ts"
import { newId } from "./ids.ts"
import { isAttributed, type Provenance } from "./provenance.ts"

export type MemoryKind =
  | "approval"
  | "architecture_decision"
  | "bug_fix"
  | "command"
  | "constraint"
  | "convention"
  | "failed_approach"

export type Confidence = "inferred" | "user_asserted" | "verified"
export type MemoryState = "current" | "revoked" | "superseded"

export interface MemoryInput {
  readonly confidence: Confidence
  readonly detail: string
  readonly kind: MemoryKind
  readonly projectId: string
  readonly provenance: Provenance
  readonly scope: readonly string[]
  readonly summary: string
  readonly title: string
}

export interface MemoryEntry extends MemoryInput {
  readonly createdAt: number
  readonly id: string
  readonly state: MemoryState
  readonly supersededBy: string | null
  readonly updatedAt: number
}

/** First retrieval level: enough to choose, small enough to list many. */
export interface CompactMemory {
  readonly confidence: Confidence
  readonly evidenceCount: number
  readonly id: string
  readonly kind: MemoryKind
  readonly scope: readonly string[]
  readonly summary: string
  readonly title: string
}

export class MemoryRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryRejected"
  }
}

export function insertMemory(database: Database, input: MemoryInput, now: number): string {
  validate(input)

  const id = newId()
  database.transaction(() => {
    database.run(
      `insert into memory (
         id, project_id, kind, confidence, state, title, summary, detail, scope,
         superseded_by, created_at, updated_at
       ) values (?, ?, ?, ?, 'current', ?, ?, ?, ?, null, ?, ?)`,
      id,
      input.projectId,
      input.kind,
      input.confidence,
      input.title,
      input.summary,
      input.detail,
      JSON.stringify([...input.scope]),
      now,
      now,
    )
    // One row per evidence identifier. The model says evidence_ids[], and collapsing them to the
    // first would make a memory backed by six gates indistinguishable from one backed by one.
    const sources = input.provenance.evidenceIds.length > 0 ? input.provenance.evidenceIds : [null]
    for (const evidenceId of sources) {
      database.run(
        `insert into memory_provenance (
           id, memory_id, candidate_id, evidence_id, revision, session_id, role, event_sequence
         ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        id,
        input.provenance.candidateId,
        evidenceId,
        input.provenance.revision,
        input.provenance.sessionId,
        input.provenance.role,
        input.provenance.eventSequence,
      )
    }
  })
  return id
}

export function searchMemory(
  database: Database,
  projectId: string,
  query: string,
  limit: number,
): CompactMemory[] {
  const match = toMatchExpression(query)
  if (match === null) return []

  const rows = database.all<Row>(
    `select m.id, m.kind, m.confidence, m.title, m.summary, m.scope,
            (select count(*) from memory_provenance p
              where p.memory_id = m.id and p.evidence_id is not null) as evidence_count
       from memory_fts f
       join memory m on m.rowid = f.rowid
      where memory_fts match ? and m.project_id = ? and m.state = 'current'
      order by bm25(memory_fts)
      limit ?`,
    match,
    projectId,
    limit,
  )

  return rows.map(toCompact)
}

/** Second retrieval level: full detail, fetched only for entries the caller selected. */
export function readMemory(database: Database, ids: readonly string[]): MemoryEntry[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => "?").join(", ")
  const rows = database.all<Row>(
    `select * from memory where id in (${placeholders})`,
    ...ids,
  )
  return rows.map((row) => toEntry(database, row))
}


/**
 * Scope retrieval. A memory declares the paths or subsystems it applies to, and a change that
 * touches one of them is the reason the memory exists. Matching is prefix based on directories, and
 * `.` means the whole project.
 */
export function memoriesInScope(
  database: Database,
  projectId: string,
  paths: readonly string[],
  limit: number,
): CompactMemory[] {
  // No area named, nothing to match against: scope retrieval answers "what applies here", and
  // without a "here" the honest answer is nothing.
  if (paths.length === 0) return []

  const rows = database.all<Row>(
    `select m.id, m.kind, m.confidence, m.title, m.summary, m.scope,
            (select count(*) from memory_provenance p
              where p.memory_id = m.id and p.evidence_id is not null) as evidence_count
       from memory m
      where m.project_id = ? and m.state = 'current'
      order by m.updated_at desc`,
    projectId,
  )

  const wanted = paths.map((path) => path.replaceAll("\\", "/"))
  return rows
    .map(toCompact)
    .filter((entry) => entry.scope.some((scope) => appliesTo(scope, wanted)))
    .slice(0, limit)
}

function appliesTo(scope: string, paths: readonly string[]): boolean {
  const normalized = scope.replaceAll("\\", "/").replace(/\/+$/u, "").trim()
  if (normalized === "" || normalized === ".") return true
  return paths.some((path) => path === normalized || path.startsWith(`${normalized}/`))
}

export interface MemoryLink {
  readonly id: string
  readonly state: MemoryState
  readonly supersededBy: string | null
  readonly title: string
}

/**
 * The supersession chain, walked from whichever entry the caller has. A memory is never overwritten,
 * so what it used to say has to remain answerable.
 */
export function memoryChain(database: Database, id: string): MemoryLink[] {
  const seen = new Set<string>()
  const chain: MemoryLink[] = []

  let head = id
  for (;;) {
    const previous = database.get<Row>(
      "select id from memory where superseded_by = ?",
      head,
    )
    if (previous === undefined) break
    const earlier = String(previous["id"])
    if (seen.has(earlier)) break
    seen.add(earlier)
    head = earlier
  }

  let current: string | null = head
  while (current !== null && !chain.some((link) => link.id === current)) {
    const row: Row | undefined = database.get<Row>("select * from memory where id = ?", current)
    if (row === undefined) break
    const next: string | null = (row["superseded_by"] as string | null) ?? null
    chain.push({
      id: String(row["id"]),
      state: String(row["state"]) as MemoryState,
      supersededBy: next,
      title: String(row["title"]),
    })
    current = next
  }

  return chain
}

/** Revocation, not deletion: the entry stays, and stops being retrieved. */
export function revokeMemory(database: Database, id: string, now: number): boolean {
  const row = database.get<Row>("select state from memory where id = ?", id)
  if (row === undefined || String(row["state"]) === "revoked") return false
  database.run("update memory set state = 'revoked', updated_at = ? where id = ?", now, id)
  return true
}

export function currentMemoryOfKind(
  database: Database,
  projectId: string,
  kind: MemoryKind,
  title: string,
): string | undefined {
  const row = database.get<Row>(
    "select id from memory where project_id = ? and kind = ? and title = ? and state = 'current'",
    projectId,
    kind,
    title,
  )
  return row === undefined ? undefined : String(row["id"])
}

function toCompact(row: Row): CompactMemory {
  return {
    confidence: String(row["confidence"]) as Confidence,
    evidenceCount: Number(row["evidence_count"]),
    id: String(row["id"]),
    kind: String(row["kind"]) as MemoryKind,
    scope: JSON.parse(String(row["scope"])) as string[],
    summary: String(row["summary"]),
    title: String(row["title"]),
  }
}

export function supersedeMemory(
  database: Database,
  previousId: string,
  replacement: MemoryInput,
  now: number,
): string {
  return database.transaction(() => {
    const id = insertMemory(database, replacement, now)
    database.run(
      "update memory set state = 'superseded', superseded_by = ?, updated_at = ? where id = ?",
      id,
      now,
      previousId,
    )
    return id
  })
}

function validate(input: MemoryInput): void {
  if (input.scope.length === 0) {
    throw new MemoryRejected("a memory needs at least one applicability scope")
  }
  if (!isAttributed(input.provenance)) {
    throw new MemoryRejected("a memory needs at least one source: candidate, evidence, revision or event")
  }
  if (input.confidence === "verified" && input.provenance.evidenceIds.length === 0) {
    throw new MemoryRejected("verified confidence requires evidence from a passed gate")
  }
  if (!input.title.trim() || !input.summary.trim() || !input.detail.trim()) {
    throw new MemoryRejected("a memory needs a title, a summary and a detail")
  }
  for (const field of [input.title, input.summary, input.detail]) {
    if (containsSecret(field)) throw new MemoryRejected("a memory cannot contain a secret")
  }
}

/**
 * FTS5 treats bare punctuation as syntax, so user text is passed as quoted terms rather than as a
 * query the caller could accidentally malform.
 */
function toMatchExpression(query: string): string | null {
  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
  return terms.length === 0 ? null : terms.join(" OR ")
}

function toEntry(database: Database, row: Row): MemoryEntry {
  const id = String(row["id"])
  const sources = database.all<Row>(
    "select * from memory_provenance where memory_id = ?",
    id,
  )
  const first = sources[0]

  return {
    confidence: String(row["confidence"]) as Confidence,
    createdAt: Number(row["created_at"]),
    detail: String(row["detail"]),
    id,
    kind: String(row["kind"]) as MemoryKind,
    projectId: String(row["project_id"]),
    provenance: {
      candidateId: (first?.["candidate_id"] as string | null) ?? null,
      eventSequence: (first?.["event_sequence"] as number | null) ?? null,
      evidenceIds: sources
        .map((source) => source["evidence_id"])
        .filter((value): value is string => typeof value === "string"),
      revision: (first?.["revision"] as string | null) ?? null,
      role: (first?.["role"] as MemoryEntry["provenance"]["role"]) ?? null,
      sessionId: (first?.["session_id"] as string | null) ?? null,
    },
    scope: JSON.parse(String(row["scope"])) as string[],
    state: String(row["state"]) as MemoryState,
    summary: String(row["summary"]),
    supersededBy: (row["superseded_by"] as string | null) ?? null,
    title: String(row["title"]),
    updatedAt: Number(row["updated_at"]),
  }
}

