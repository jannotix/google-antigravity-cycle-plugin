import type { Database, Row } from "./database.ts"
import { newId } from "./ids.ts"
import { serializeProvenance, type Provenance } from "./provenance.ts"

export type EdgeKind = "calls" | "defines" | "exports" | "imports" | "inherits" | "references"
export type Confidence = "extracted" | "inferred"

export interface GraphNode {
  readonly digest: string
  readonly endLine: number
  readonly id: string
  readonly kind: string
  readonly language: string
  readonly name: string
  readonly path: string
  readonly startLine: number
}

export interface GraphEdge {
  readonly confidence: Confidence
  readonly fromId: string
  readonly kind: EdgeKind
  readonly provenance: Provenance
  readonly toId: string
}

export interface FileReference {
  readonly kind: "calls" | "imports"
  readonly line: number
  readonly target: string
}

export interface IndexedFile {
  readonly digest: string
  readonly indexedAt: number
  readonly language: string | null
  /** Last write time as the filesystem reported it, or -1 when it was never recorded. */
  readonly modifiedAt: number
  readonly path: string
  readonly references: readonly FileReference[]
  readonly size: number
}

/** Replaces one file's contribution atomically: stale nodes and their edges never survive. */
export function replaceFile(
  database: Database,
  projectId: string,
  file: IndexedFile,
  nodes: readonly Omit<GraphNode, "id">[],
): Map<string, string> {
  return database.transaction(() => {
    database.run(
      "delete from graph_nodes where project_id = ? and path = ?",
      projectId,
      file.path,
    )

    const ids = new Map<string, string>()
    for (const node of nodes) {
      const id = newId()
      ids.set(`${node.kind}:${node.name}:${node.startLine}`, id)
      database.run(
        `insert into graph_nodes (id, project_id, kind, name, path, start_line, end_line, language, digest)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        projectId,
        node.kind,
        node.name,
        node.path,
        node.startLine,
        node.endLine,
        node.language,
        node.digest,
      )
    }

    database.run(
      `insert into index_state (
         project_id, path, digest, language, indexed_at, refs_json, size, modified_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (project_id, path) do update set
         digest = excluded.digest, language = excluded.language,
         indexed_at = excluded.indexed_at, refs_json = excluded.refs_json,
         size = excluded.size, modified_at = excluded.modified_at`,
      projectId,
      file.path,
      file.digest,
      file.language,
      file.indexedAt,
      JSON.stringify(file.references),
      file.size,
      file.modifiedAt,
    )

    return ids
  })
}

export function insertEdges(database: Database, projectId: string, edges: readonly GraphEdge[]): void {
  if (edges.length === 0) return
  database.transaction(() => {
    for (const edge of edges) {
      database.run(
        `insert into graph_edges (id, project_id, from_id, to_id, kind, confidence, provenance)
         values (?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        projectId,
        edge.fromId,
        edge.toId,
        edge.kind,
        edge.confidence,
        serializeProvenance(edge.provenance),
      )
    }
  })
}

export function forgetFile(database: Database, projectId: string, path: string): void {
  database.transaction(() => {
    database.run("delete from graph_nodes where project_id = ? and path = ?", projectId, path)
    database.run("delete from index_state where project_id = ? and path = ?", projectId, path)
  })
}

export function indexedFiles(database: Database, projectId: string): Map<string, IndexedFile> {
  const rows = database.all<Row>("select * from index_state where project_id = ?", projectId)
  return new Map(
    rows.map((row) => [
      String(row["path"]),
      {
        digest: String(row["digest"]),
        indexedAt: Number(row["indexed_at"]),
        language: (row["language"] as string | null) ?? null,
        modifiedAt: Number(row["modified_at"] ?? -1),
        path: String(row["path"]),
        references: JSON.parse(String(row["refs_json"] ?? "[]")) as FileReference[],
        size: Number(row["size"] ?? -1),
      },
    ]),
  )
}

export function nodesByName(
  database: Database,
  projectId: string,
  name: string,
): GraphNode[] {
  return database
    .all<Row>("select * from graph_nodes where project_id = ? and name = ?", projectId, name)
    .map(toNode)
}

export function nodesInFiles(
  database: Database,
  projectId: string,
  paths: readonly string[],
): GraphNode[] {
  if (paths.length === 0) return []
  const placeholders = paths.map(() => "?").join(", ")
  return database
    .all<Row>(
      `select * from graph_nodes where project_id = ? and path in (${placeholders}) order by path, start_line`,
      projectId,
      ...paths,
    )
    .map(toNode)
}

export interface Neighbour {
  readonly confidence: Confidence
  readonly direction: "incoming" | "outgoing"
  readonly edge: EdgeKind
  readonly node: GraphNode
}

export function neighbours(database: Database, nodeId: string): Neighbour[] {
  const outgoing = database.all<Row>(
    `select n.*, e.kind as edge_kind, e.confidence as edge_confidence
       from graph_edges e join graph_nodes n on n.id = e.to_id
      where e.from_id = ?`,
    nodeId,
  )
  const incoming = database.all<Row>(
    `select n.*, e.kind as edge_kind, e.confidence as edge_confidence
       from graph_edges e join graph_nodes n on n.id = e.from_id
      where e.to_id = ?`,
    nodeId,
  )

  return [
    ...outgoing.map((row) => toNeighbour(row, "outgoing")),
    ...incoming.map((row) => toNeighbour(row, "incoming")),
  ]
}

export function graphSize(
  database: Database,
  projectId: string,
): { edges: number; files: number; nodes: number } {
  const count = (sql: string): number =>
    Number(database.get<{ total: number }>(sql, projectId)?.total ?? 0)
  return {
    edges: count("select count(*) as total from graph_edges where project_id = ?"),
    files: count("select count(*) as total from index_state where project_id = ?"),
    nodes: count("select count(*) as total from graph_nodes where project_id = ?"),
  }
}

function toNode(row: Row): GraphNode {
  return {
    digest: String(row["digest"]),
    endLine: Number(row["end_line"]),
    id: String(row["id"]),
    kind: String(row["kind"]),
    language: String(row["language"]),
    name: String(row["name"]),
    path: String(row["path"]),
    startLine: Number(row["start_line"]),
  }
}

function toNeighbour(row: Row, direction: Neighbour["direction"]): Neighbour {
  return {
    confidence: String(row["edge_confidence"]) as Confidence,
    direction,
    edge: String(row["edge_kind"]) as EdgeKind,
    node: toNode(row),
  }
}
