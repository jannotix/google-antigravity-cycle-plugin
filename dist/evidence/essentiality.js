import { nodesByName, nodesInFiles } from "../store/graph.js";
const DEFINITION_KINDS = new Set(["class", "component", "function", "interface", "type"]);
const MIN_NAME_LENGTH = 4;
const COMMON_NAMES = new Set([
    "build",
    "close",
    "config",
    "create",
    "data",
    "delete",
    "error",
    "handler",
    "index",
    "init",
    "item",
    "list",
    "load",
    "main",
    "name",
    "next",
    "open",
    "options",
    "parse",
    "read",
    "remove",
    "render",
    "result",
    "save",
    "setup",
    "start",
    "state",
    "stop",
    "test",
    "update",
    "value",
    "write",
]);
export function reimplementedCapabilities(database, projectId, changed) {
    const addedPaths = changed.filter((file) => file.kind === "added").map((file) => file.path);
    if (addedPaths.length === 0)
        return [];
    const added = new Set(addedPaths);
    const duplicates = [];
    const seen = new Set();
    for (const node of nodesInFiles(database, projectId, addedPaths)) {
        if (!DEFINITION_KINDS.has(node.kind))
            continue;
        if (node.name.length < MIN_NAME_LENGTH)
            continue;
        if (COMMON_NAMES.has(node.name.toLowerCase()))
            continue;
        if (seen.has(node.name))
            continue;
        const elsewhere = nodesByName(database, projectId, node.name).filter((other) => !added.has(other.path) && DEFINITION_KINDS.has(other.kind));
        if (elsewhere.length !== 1)
            continue;
        seen.add(node.name);
        duplicates.push({
            addedIn: node.path,
            existsIn: elsewhere[0].path,
            kind: node.kind,
            name: node.name,
        });
    }
    return duplicates;
}
