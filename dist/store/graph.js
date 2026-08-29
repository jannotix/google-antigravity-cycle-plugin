import { newId } from "./ids.js";
import { serializeProvenance } from "./provenance.js";
export function replaceFile(database, projectId, file, nodes) {
    return database.transaction(() => {
        database.run("delete from graph_nodes where project_id = ? and path = ?", projectId, file.path);
        const ids = new Map();
        for (const node of nodes) {
            const id = newId();
            ids.set(`${node.kind}:${node.name}:${node.startLine}`, id);
            database.run(`insert into graph_nodes (id, project_id, kind, name, path, start_line, end_line, language, digest)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, projectId, node.kind, node.name, node.path, node.startLine, node.endLine, node.language, node.digest);
        }
        database.run(`insert into index_state (
         project_id, path, digest, language, indexed_at, refs_json, size, modified_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (project_id, path) do update set
         digest = excluded.digest, language = excluded.language,
         indexed_at = excluded.indexed_at, refs_json = excluded.refs_json,
         size = excluded.size, modified_at = excluded.modified_at`, projectId, file.path, file.digest, file.language, file.indexedAt, JSON.stringify(file.references), file.size, file.modifiedAt);
        return ids;
    });
}
export function insertEdges(database, projectId, edges) {
    if (edges.length === 0)
        return;
    database.transaction(() => {
        for (const edge of edges) {
            database.run(`insert into graph_edges (id, project_id, from_id, to_id, kind, confidence, provenance)
         values (?, ?, ?, ?, ?, ?, ?)`, newId(), projectId, edge.fromId, edge.toId, edge.kind, edge.confidence, serializeProvenance(edge.provenance));
        }
    });
}
export function forgetFile(database, projectId, path) {
    database.transaction(() => {
        database.run("delete from graph_nodes where project_id = ? and path = ?", projectId, path);
        database.run("delete from index_state where project_id = ? and path = ?", projectId, path);
    });
}
export function indexedFiles(database, projectId) {
    const rows = database.all("select * from index_state where project_id = ?", projectId);
    return new Map(rows.map((row) => [
        String(row["path"]),
        {
            digest: String(row["digest"]),
            indexedAt: Number(row["indexed_at"]),
            language: row["language"] ?? null,
            modifiedAt: Number(row["modified_at"] ?? -1),
            path: String(row["path"]),
            references: JSON.parse(String(row["refs_json"] ?? "[]")),
            size: Number(row["size"] ?? -1),
        },
    ]));
}
export function nodesByName(database, projectId, name) {
    return database
        .all("select * from graph_nodes where project_id = ? and name = ?", projectId, name)
        .map(toNode);
}
export function nodesInFiles(database, projectId, paths) {
    if (paths.length === 0)
        return [];
    const placeholders = paths.map(() => "?").join(", ");
    return database
        .all(`select * from graph_nodes where project_id = ? and path in (${placeholders}) order by path, start_line`, projectId, ...paths)
        .map(toNode);
}
export function neighbours(database, nodeId) {
    const outgoing = database.all(`select n.*, e.kind as edge_kind, e.confidence as edge_confidence
       from graph_edges e join graph_nodes n on n.id = e.to_id
      where e.from_id = ?`, nodeId);
    const incoming = database.all(`select n.*, e.kind as edge_kind, e.confidence as edge_confidence
       from graph_edges e join graph_nodes n on n.id = e.from_id
      where e.to_id = ?`, nodeId);
    return [
        ...outgoing.map((row) => toNeighbour(row, "outgoing")),
        ...incoming.map((row) => toNeighbour(row, "incoming")),
    ];
}
export function graphSize(database, projectId) {
    const count = (sql) => Number(database.get(sql, projectId)?.total ?? 0);
    return {
        edges: count("select count(*) as total from graph_edges where project_id = ?"),
        files: count("select count(*) as total from index_state where project_id = ?"),
        nodes: count("select count(*) as total from graph_nodes where project_id = ?"),
    };
}
function toNode(row) {
    return {
        digest: String(row["digest"]),
        endLine: Number(row["end_line"]),
        id: String(row["id"]),
        kind: String(row["kind"]),
        language: String(row["language"]),
        name: String(row["name"]),
        path: String(row["path"]),
        startLine: Number(row["start_line"]),
    };
}
function toNeighbour(row, direction) {
    return {
        confidence: String(row["edge_confidence"]),
        direction,
        edge: String(row["edge_kind"]),
        node: toNode(row),
    };
}
