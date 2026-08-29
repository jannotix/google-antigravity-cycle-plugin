import { containsSecret } from "../secrets.js";
import { newId } from "./ids.js";
import { isAttributed } from "./provenance.js";
export class MemoryRejected extends Error {
    constructor(message) {
        super(message);
        this.name = "MemoryRejected";
    }
}
export function insertMemory(database, input, now) {
    validate(input);
    const id = newId();
    database.transaction(() => {
        database.run(`insert into memory (
         id, project_id, kind, confidence, state, title, summary, detail, scope,
         superseded_by, created_at, updated_at
       ) values (?, ?, ?, ?, 'current', ?, ?, ?, ?, null, ?, ?)`, id, input.projectId, input.kind, input.confidence, input.title, input.summary, input.detail, JSON.stringify([...input.scope]), now, now);
        const sources = input.provenance.evidenceIds.length > 0 ? input.provenance.evidenceIds : [null];
        for (const evidenceId of sources) {
            database.run(`insert into memory_provenance (
           id, memory_id, candidate_id, evidence_id, revision, session_id, role, event_sequence
         ) values (?, ?, ?, ?, ?, ?, ?, ?)`, newId(), id, input.provenance.candidateId, evidenceId, input.provenance.revision, input.provenance.sessionId, input.provenance.role, input.provenance.eventSequence);
        }
    });
    return id;
}
export function searchMemory(database, projectId, query, limit) {
    const match = toMatchExpression(query);
    if (match === null)
        return [];
    const rows = database.all(`select m.id, m.kind, m.confidence, m.title, m.summary, m.scope,
            (select count(*) from memory_provenance p
              where p.memory_id = m.id and p.evidence_id is not null) as evidence_count
       from memory_fts f
       join memory m on m.rowid = f.rowid
      where memory_fts match ? and m.project_id = ? and m.state = 'current'
      order by bm25(memory_fts)
      limit ?`, match, projectId, limit);
    return rows.map(toCompact);
}
export function readMemory(database, ids) {
    if (ids.length === 0)
        return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = database.all(`select * from memory where id in (${placeholders})`, ...ids);
    return rows.map((row) => toEntry(database, row));
}
export function memoriesInScope(database, projectId, paths, limit) {
    if (paths.length === 0)
        return [];
    const rows = database.all(`select m.id, m.kind, m.confidence, m.title, m.summary, m.scope,
            (select count(*) from memory_provenance p
              where p.memory_id = m.id and p.evidence_id is not null) as evidence_count
       from memory m
      where m.project_id = ? and m.state = 'current'
      order by m.updated_at desc`, projectId);
    const wanted = paths.map((path) => path.replaceAll("\\", "/"));
    return rows
        .map(toCompact)
        .filter((entry) => entry.scope.some((scope) => appliesTo(scope, wanted)))
        .slice(0, limit);
}
function appliesTo(scope, paths) {
    const normalized = scope.replaceAll("\\", "/").replace(/\/+$/u, "").trim();
    if (normalized === "" || normalized === ".")
        return true;
    return paths.some((path) => path === normalized || path.startsWith(`${normalized}/`));
}
export function memoryChain(database, id) {
    const seen = new Set();
    const chain = [];
    let head = id;
    for (;;) {
        const previous = database.get("select id from memory where superseded_by = ?", head);
        if (previous === undefined)
            break;
        const earlier = String(previous["id"]);
        if (seen.has(earlier))
            break;
        seen.add(earlier);
        head = earlier;
    }
    let current = head;
    while (current !== null && !chain.some((link) => link.id === current)) {
        const row = database.get("select * from memory where id = ?", current);
        if (row === undefined)
            break;
        const next = row["superseded_by"] ?? null;
        chain.push({
            id: String(row["id"]),
            state: String(row["state"]),
            supersededBy: next,
            title: String(row["title"]),
        });
        current = next;
    }
    return chain;
}
export function revokeMemory(database, id, now) {
    const row = database.get("select state from memory where id = ?", id);
    if (row === undefined || String(row["state"]) === "revoked")
        return false;
    database.run("update memory set state = 'revoked', updated_at = ? where id = ?", now, id);
    return true;
}
export function currentMemoryOfKind(database, projectId, kind, title) {
    const row = database.get("select id from memory where project_id = ? and kind = ? and title = ? and state = 'current'", projectId, kind, title);
    return row === undefined ? undefined : String(row["id"]);
}
function toCompact(row) {
    return {
        confidence: String(row["confidence"]),
        evidenceCount: Number(row["evidence_count"]),
        id: String(row["id"]),
        kind: String(row["kind"]),
        scope: JSON.parse(String(row["scope"])),
        summary: String(row["summary"]),
        title: String(row["title"]),
    };
}
export function supersedeMemory(database, previousId, replacement, now) {
    return database.transaction(() => {
        const id = insertMemory(database, replacement, now);
        database.run("update memory set state = 'superseded', superseded_by = ?, updated_at = ? where id = ?", id, now, previousId);
        return id;
    });
}
function validate(input) {
    if (input.scope.length === 0) {
        throw new MemoryRejected("a memory needs at least one applicability scope");
    }
    if (!isAttributed(input.provenance)) {
        throw new MemoryRejected("a memory needs at least one source: candidate, evidence, revision or event");
    }
    if (input.confidence === "verified" && input.provenance.evidenceIds.length === 0) {
        throw new MemoryRejected("verified confidence requires evidence from a passed gate");
    }
    if (!input.title.trim() || !input.summary.trim() || !input.detail.trim()) {
        throw new MemoryRejected("a memory needs a title, a summary and a detail");
    }
    for (const field of [input.title, input.summary, input.detail]) {
        if (containsSecret(field))
            throw new MemoryRejected("a memory cannot contain a secret");
    }
}
function toMatchExpression(query) {
    const terms = query
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length > 0)
        .map((term) => `"${term}"`);
    return terms.length === 0 ? null : terms.join(" OR ");
}
function toEntry(database, row) {
    const id = String(row["id"]);
    const sources = database.all("select * from memory_provenance where memory_id = ?", id);
    const first = sources[0];
    return {
        confidence: String(row["confidence"]),
        createdAt: Number(row["created_at"]),
        detail: String(row["detail"]),
        id,
        kind: String(row["kind"]),
        projectId: String(row["project_id"]),
        provenance: {
            candidateId: first?.["candidate_id"] ?? null,
            eventSequence: first?.["event_sequence"] ?? null,
            evidenceIds: sources
                .map((source) => source["evidence_id"])
                .filter((value) => typeof value === "string"),
            revision: first?.["revision"] ?? null,
            role: first?.["role"] ?? null,
            sessionId: first?.["session_id"] ?? null,
        },
        scope: JSON.parse(String(row["scope"])),
        state: String(row["state"]),
        summary: String(row["summary"]),
        supersededBy: row["superseded_by"] ?? null,
        title: String(row["title"]),
        updatedAt: Number(row["updated_at"]),
    };
}
