import { neighbours, nodesByName, nodesInFiles, } from "../store/graph.js";
const DEFAULT_BUDGET_BYTES = 64 * 1024;
export function neighboursOf(database, nodeId, depth) {
    const seen = new Set([nodeId]);
    const edges = [];
    let frontier = [nodeId];
    for (let level = 0; level < Math.max(1, Math.min(depth, 4)); level += 1) {
        const next = [];
        for (const id of frontier) {
            for (const neighbour of neighbours(database, id)) {
                edges.push(neighbour);
                if (seen.has(neighbour.node.id))
                    continue;
                seen.add(neighbour.node.id);
                next.push(neighbour.node.id);
            }
        }
        if (next.length === 0)
            break;
        frontier = next;
    }
    return { edges, visited: [...seen] };
}
export function impactOf(database, projectId, paths, depth = 2) {
    const seeds = nodesInFiles(database, projectId, paths);
    const seen = new Set(seeds.map((node) => node.id));
    const reached = new Map();
    let frontier = seeds.map((node) => node.id);
    for (let level = 0; level < Math.max(1, Math.min(depth, 4)); level += 1) {
        const next = [];
        for (const id of frontier) {
            for (const neighbour of neighbours(database, id)) {
                if (neighbour.direction !== "incoming" || seen.has(neighbour.node.id))
                    continue;
                seen.add(neighbour.node.id);
                reached.set(neighbour.node.id, neighbour.node);
                next.push(neighbour.node.id);
            }
        }
        if (next.length === 0)
            break;
        frontier = next;
    }
    return [...reached.values()];
}
export function findSymbol(database, projectId, name) {
    return nodesByName(database, projectId, name);
}
export function scopeBundle(database, projectId, paths, budgetBytes = DEFAULT_BUDGET_BYTES) {
    const direct = nodesInFiles(database, projectId, paths);
    const related = impactOf(database, projectId, paths, 1);
    const ordered = [...direct, ...related.filter((node) => !paths.includes(node.path))];
    const nodes = [];
    let used = 0;
    let truncated = false;
    for (const node of ordered) {
        const size = JSON.stringify(node).length;
        if (used + size > budgetBytes) {
            truncated = true;
            break;
        }
        used += size;
        nodes.push(node);
    }
    return {
        nodes,
        paths: [...new Set(nodes.map((node) => node.path))],
        truncated,
    };
}
