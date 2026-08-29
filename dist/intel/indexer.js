import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { graphSize, indexedFiles, insertEdges, nodesByName, nodesInFiles, replaceFile, } from "../store/graph.js";
import { provenance } from "../store/provenance.js";
import { isSupported } from "./languages.js";
import { ParsePool } from "./pool.js";
import { gitArgs } from "../git.js";
const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const STAT_CHUNK = 512;
const PARSE_CHUNK = 10_000;
const MODULE_KIND = "module";
export async function indexProject(database, projectId, root, options = {}) {
    const projectRoot = resolve(root);
    const known = indexedFiles(database, projectId);
    const present = await discover(projectRoot);
    const changed = [];
    const digests = new Map();
    let unchanged = 0;
    let yielded = false;
    const stats = new Map();
    const startedScan = Date.now();
    const paths = [...present];
    for (let start = 0; start < paths.length; start += STAT_CHUNK) {
        const slice = paths.slice(start, start + STAT_CHUNK);
        const infos = await Promise.all(slice.map((path) => statOf(join(projectRoot, path))));
        for (const [offset, path] of slice.entries()) {
            options.signal?.throwIfAborted();
            const info = infos[offset] ?? null;
            if (info === null)
                continue;
            stats.set(path, info);
            const recorded = known.get(path);
            if (recorded !== undefined &&
                recorded.size === info.size &&
                recorded.modifiedAt === info.modifiedAt &&
                info.modifiedAt >= 0 &&
                info.modifiedAt < recorded.indexedAt) {
                unchanged += 1;
                continue;
            }
            const digest = await digestOf(join(projectRoot, path), info.size);
            if (digest === null)
                continue;
            digests.set(path, digest);
            if (recorded?.digest === digest) {
                unchanged += 1;
                touchIndexState(database, projectId, path, info.size, info.modifiedAt, Date.now());
            }
            else {
                changed.push(path);
            }
        }
    }
    let removed = 0;
    for (const path of known.keys()) {
        if (present.has(path))
            continue;
        database.transaction(() => {
            database.run("delete from graph_nodes where project_id = ? and path = ?", projectId, path);
            database.run("delete from index_state where project_id = ? and path = ?", projectId, path);
        });
        removed += 1;
    }
    const scan = Date.now() - startedScan;
    const startedParse = Date.now();
    const pool = options.pool ?? new ParsePool();
    let skipped = 0;
    let updated = 0;
    try {
        let done = 0;
        for (let start = 0; start < changed.length; start += PARSE_CHUNK) {
            if (options.shouldYield?.() === true) {
                yielded = true;
                break;
            }
            const slice = changed.slice(start, start + PARSE_CHUNK);
            const outcomes = await pool.parse(slice.map((path) => join(projectRoot, path)));
            for (const outcome of outcomes) {
                options.signal?.throwIfAborted();
                if (options.shouldYield?.() === true) {
                    yielded = true;
                    break;
                }
                const path = normalize(relative(projectRoot, outcome.path));
                if ("skipped" in outcome)
                    skipped += 1;
                else {
                    persist(database, projectId, path, digests.get(path) ?? "", outcome, stats.get(path));
                    updated += 1;
                }
                options.onProgress?.((done += 1), changed.length);
            }
            if (yielded)
                break;
        }
    }
    finally {
        if (options.pool === undefined)
            await pool.dispose();
    }
    const parse = Date.now() - startedParse;
    const startedEdges = Date.now();
    const indexed = indexedFiles(database, projectId);
    resolveEdges(database, projectId, affected(indexed, changed), indexed);
    const edgesMs = Date.now() - startedEdges;
    const size = graphSize(database, projectId);
    return {
        edges: size.edges,
        files: size.files,
        nodes: size.nodes,
        removed,
        skipped,
        spent: { edges: edgesMs, parse, scan },
        unchanged,
        updated,
        yielded,
    };
}
function touchIndexState(database, projectId, path, size, modifiedAt, indexedAt) {
    database.run("update index_state set size = ?, modified_at = ?, indexed_at = ? where project_id = ? and path = ?", size, modifiedAt, indexedAt, projectId, path);
}
function persist(database, projectId, path, digest, parsed, info) {
    const shared = { digest, language: parsed.language, path };
    const nodes = [
        { ...shared, endLine: 0, kind: MODULE_KIND, name: path, startLine: 0 },
        ...parsed.nodes.map((node) => ({
            ...shared,
            endLine: node.endLine,
            kind: node.kind,
            name: node.name,
            startLine: node.startLine,
        })),
    ];
    replaceFile(database, projectId, {
        digest,
        indexedAt: Date.now(),
        language: parsed.language,
        modifiedAt: info?.modifiedAt ?? -1,
        path,
        references: [...parsed.references],
        size: info?.size ?? -1,
    }, nodes);
}
function affected(files, changed) {
    if (changed.length === 0)
        return [];
    const result = new Set(changed);
    const moved = new Set(changed);
    for (const [path, file] of files) {
        if (result.has(path))
            continue;
        for (const reference of file.references) {
            if (reference.kind !== "imports")
                continue;
            const target = resolveImport(path, reference.target, files);
            if (target !== null && moved.has(target)) {
                result.add(path);
                break;
            }
        }
    }
    return [...result];
}
function resolveEdges(database, projectId, paths, files) {
    if (paths.length === 0)
        return;
    const edges = [];
    for (const path of paths) {
        const all = nodesInFiles(database, projectId, [path]);
        const moduleNode = all.find((node) => node.kind === MODULE_KIND);
        if (moduleNode === undefined)
            continue;
        const definitions = all.filter((node) => node.kind !== MODULE_KIND);
        for (const definition of definitions) {
            edges.push({
                confidence: "extracted",
                fromId: moduleNode.id,
                kind: "defines",
                provenance: provenance(),
                toId: definition.id,
            });
        }
        const references = files.get(path)?.references ?? [];
        const imported = new Set();
        for (const reference of references) {
            if (reference.kind !== "imports")
                continue;
            const target = resolveImport(path, reference.target, files);
            if (target === null)
                continue;
            imported.add(target);
            const targetModule = nodesInFiles(database, projectId, [target]).find((node) => node.kind === MODULE_KIND);
            if (targetModule !== undefined) {
                edges.push({
                    confidence: "extracted",
                    fromId: moduleNode.id,
                    kind: "imports",
                    provenance: provenance(),
                    toId: targetModule.id,
                });
            }
        }
        for (const reference of references) {
            if (reference.kind !== "calls")
                continue;
            const source = enclosing(definitions, reference.line) ?? moduleNode;
            const candidates = nodesByName(database, projectId, reference.target).filter((node) => node.kind !== MODULE_KIND);
            for (const target of pickCallTargets(candidates, path, imported)) {
                edges.push({
                    confidence: target.path === path || imported.has(target.path) ? "extracted" : "inferred",
                    fromId: source.id,
                    kind: "calls",
                    provenance: provenance(),
                    toId: target.id,
                });
            }
        }
    }
    insertEdges(database, projectId, edges);
}
function pickCallTargets(candidates, path, imported) {
    const local = candidates.filter((node) => node.path === path || imported.has(node.path));
    if (local.length > 0)
        return local;
    return candidates.length === 1 ? candidates : [];
}
function enclosing(nodes, line) {
    let best;
    for (const node of nodes) {
        if (node.startLine > line || node.endLine < line)
            continue;
        if (best === undefined || node.endLine - node.startLine < best.endLine - best.startLine) {
            best = node;
        }
    }
    return best;
}
const EXTENSIONS = [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
    ".rb",
    ".php",
    ".java",
    ".cs",
    ".css",
];
function resolveImport(fromPath, specifier, files) {
    if (!specifier.startsWith("."))
        return null;
    const base = normalize(join(dirname(fromPath), specifier));
    for (const extension of EXTENSIONS) {
        const candidate = normalize(base + extension);
        if (files.has(candidate))
            return candidate;
        if (extension !== "") {
            const asIndex = normalize(join(base, `index${extension}`));
            if (files.has(asIndex))
                return asIndex;
        }
    }
    return null;
}
async function discover(root) {
    const tracked = await gitFiles(root);
    const files = tracked ?? (await walk(root, root));
    return new Set([...files].filter(isSupported));
}
async function gitFiles(root) {
    try {
        const { stdout } = await execFileAsync("git", gitArgs(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: false, windowsHide: true });
        return new Set(stdout.split("\0").filter(Boolean).map(normalize));
    }
    catch {
        return null;
    }
}
const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", ".venv"]);
async function walk(root, directory, into = new Set()) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || IGNORED.has(entry.name))
            continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory())
            await walk(root, full, into);
        else if (entry.isFile())
            into.add(normalize(relative(root, full)));
    }
    return into;
}
async function statOf(path) {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_FILE_BYTES)
            return null;
        return { modifiedAt: Math.floor(info.mtimeMs), size: info.size };
    }
    catch {
        return null;
    }
}
async function digestOf(path, size) {
    try {
        if (size === undefined) {
            const info = await stat(path);
            if (!info.isFile() || info.size > MAX_FILE_BYTES)
                return null;
        }
        return createHash("sha256")
            .update(await readFile(path))
            .digest("hex");
    }
    catch {
        return null;
    }
}
function normalize(path) {
    return path.split(sep).join("/");
}
