import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import type { Database } from "../store/database.ts"
import {
  graphSize,
  indexedFiles,
  insertEdges,
  nodesByName,
  nodesInFiles,
  replaceFile,
  type FileReference,
  type GraphEdge,
  type GraphNode,
  type IndexedFile,
} from "../store/graph.ts"
import { provenance } from "../store/provenance.ts"
import { isSupported } from "./languages.ts"
import type { ParseResult } from "./parser.ts"
import { ParsePool } from "./pool.ts"
import { gitArgs } from "../git.ts"

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Enough to keep every worker busy, small enough that memory does not grow with the corpus. */
const PARSE_CHUNK = 10_000
const MODULE_KIND = "module"

export interface IndexReport {
  readonly edges: number
  readonly files: number
  readonly nodes: number
  readonly removed: number
  readonly skipped: number
  readonly unchanged: number
  readonly updated: number
  /** True when indexing stopped early to leave the machine to something more urgent. */
  readonly yielded: boolean
}

export interface IndexOptions {
  readonly onProgress?: (done: number, total: number) => void
  readonly pool?: ParsePool
  /**
   * Checked between files. Indexing is incremental and every parsed file is already persisted,
   * so yielding stops rather than unwinds: the next run continues from what is left.
   */
  readonly shouldYield?: () => boolean
  readonly signal?: AbortSignal
}

/**
 * Incremental by content digest: a file whose bytes are unchanged is never reparsed, which is the
 * property that makes a large repository affordable after the first pass.
 */
export async function indexProject(
  database: Database,
  projectId: string,
  root: string,
  options: IndexOptions = {},
): Promise<IndexReport> {
  const projectRoot = resolve(root)
  const known = indexedFiles(database, projectId)
  const present = await discover(projectRoot)

  const changed: string[] = []
  const digests = new Map<string, string>()
  let unchanged = 0
  let yielded = false

  const stats = new Map<string, { modifiedAt: number; size: number }>()
  for (const path of present) {
    options.signal?.throwIfAborted()

    const info = await statOf(join(projectRoot, path))
    if (info === null) continue
    stats.set(path, info)

    // The cheap question first. A recorded entry whose size and last-write time still match was
    // read once and does not need reading again — which is the difference between minutes and
    // hours on a large repository. `modifiedAt < indexedAt` closes the race where a file is written
    // in the same tick it was indexed in: then the digest decides, as it always could.
    const recorded = known.get(path)
    if (
      recorded !== undefined &&
      recorded.size === info.size &&
      recorded.modifiedAt === info.modifiedAt &&
      info.modifiedAt >= 0 &&
      info.modifiedAt < recorded.indexedAt
    ) {
      unchanged += 1
      continue
    }

    const digest = await digestOf(join(projectRoot, path), info.size)
    if (digest === null) continue
    digests.set(path, digest)
    if (recorded?.digest === digest) {
      unchanged += 1
      // Touched but unchanged: refresh the stat cache so the next pass answers without reading.
      touchIndexState(database, projectId, path, info.size, info.modifiedAt, Date.now())
    } else {
      changed.push(path)
    }
  }

  let removed = 0
  for (const path of known.keys()) {
    if (present.has(path)) continue
    database.transaction(() => {
      database.run("delete from graph_nodes where project_id = ? and path = ?", projectId, path)
      database.run("delete from index_state where project_id = ? and path = ?", projectId, path)
    })
    removed += 1
  }

  const pool = options.pool ?? new ParsePool()
  let skipped = 0
  let updated = 0
  try {
    let done = 0
    // Parsed and persisted a chunk at a time. Handing the pool every path at once would hold every
    // result in memory before writing one of them, report no progress until the end, and lose the
    // whole pass to an interruption — none of which is affordable on a large repository.
    for (let start = 0; start < changed.length; start += PARSE_CHUNK) {
      if (options.shouldYield?.() === true) {
        yielded = true
        break
      }
      const slice = changed.slice(start, start + PARSE_CHUNK)
      const outcomes = await pool.parse(slice.map((path) => join(projectRoot, path)))

      for (const outcome of outcomes) {
        options.signal?.throwIfAborted()
        if (options.shouldYield?.() === true) {
          yielded = true
          break
        }
        const path = normalize(relative(projectRoot, outcome.path))
        if ("skipped" in outcome) skipped += 1
        else {
          persist(database, projectId, path, digests.get(path) ?? "", outcome, stats.get(path))
          updated += 1
        }
        options.onProgress?.((done += 1), changed.length)
      }
      if (yielded) break
    }
  } finally {
    if (options.pool === undefined) await pool.dispose()
  }

  resolveEdges(database, projectId, affected(database, projectId, changed))

  const size = graphSize(database, projectId)
  return {
    edges: size.edges,
    files: size.files,
    nodes: size.nodes,
    removed,
    skipped,
    unchanged,
    updated,
    yielded,
  }
}

/** Refreshes only the stat cache: the bytes did not change, so nothing else has to. */
function touchIndexState(
  database: Database,
  projectId: string,
  path: string,
  size: number,
  modifiedAt: number,
  indexedAt: number,
): void {
  database.run(
    "update index_state set size = ?, modified_at = ?, indexed_at = ? where project_id = ? and path = ?",
    size,
    modifiedAt,
    indexedAt,
    projectId,
    path,
  )
}

function persist(
  database: Database,
  projectId: string,
  path: string,
  digest: string,
  parsed: ParseResult,
  info: { modifiedAt: number; size: number } | undefined,
): void {
  const shared = { digest, language: parsed.language, path }
  const nodes: Omit<GraphNode, "id">[] = [
    { ...shared, endLine: 0, kind: MODULE_KIND, name: path, startLine: 0 },
    ...parsed.nodes.map((node) => ({
      ...shared,
      endLine: node.endLine,
      kind: node.kind,
      name: node.name,
      startLine: node.startLine,
    })),
  ]

  replaceFile(
    database,
    projectId,
    {
      digest,
      indexedAt: Date.now(),
      language: parsed.language,
      modifiedAt: info?.modifiedAt ?? -1,
      path,
      references: [...parsed.references],
      size: info?.size ?? -1,
    },
    nodes,
  )
}

/**
 * A file that imports a changed file may now resolve a call it could not resolve before, so its
 * edges are recomputed too. Everything else keeps the edges it already has.
 */
function affected(database: Database, projectId: string, changed: readonly string[]): string[] {
  if (changed.length === 0) return []

  const files = indexedFiles(database, projectId)
  const result = new Set(changed)
  // A set, not the array: this is a lookup inside a loop over every file, and a linear scan here
  // makes a first index quadratic in the size of the repository.
  const moved = new Set(changed)
  for (const [path, file] of files) {
    if (result.has(path)) continue
    for (const reference of file.references) {
      if (reference.kind !== "imports") continue
      const target = resolveImport(path, reference.target, files)
      if (target !== null && moved.has(target)) {
        result.add(path)
        break
      }
    }
  }
  return [...result]
}

function resolveEdges(database: Database, projectId: string, paths: readonly string[]): void {
  if (paths.length === 0) return

  const files = indexedFiles(database, projectId)
  const edges: GraphEdge[] = []

  for (const path of paths) {
    const all = nodesInFiles(database, projectId, [path])
    const moduleNode = all.find((node) => node.kind === MODULE_KIND)
    if (moduleNode === undefined) continue
    const definitions = all.filter((node) => node.kind !== MODULE_KIND)

    for (const definition of definitions) {
      edges.push({
        confidence: "extracted",
        fromId: moduleNode.id,
        kind: "defines",
        provenance: provenance(),
        toId: definition.id,
      })
    }

    const references = files.get(path)?.references ?? []
    const imported = new Set<string>()
    for (const reference of references) {
      if (reference.kind !== "imports") continue
      const target = resolveImport(path, reference.target, files)
      if (target === null) continue
      imported.add(target)
      const targetModule = nodesInFiles(database, projectId, [target]).find(
        (node) => node.kind === MODULE_KIND,
      )
      if (targetModule !== undefined) {
        edges.push({
          confidence: "extracted",
          fromId: moduleNode.id,
          kind: "imports",
          provenance: provenance(),
          toId: targetModule.id,
        })
      }
    }

    for (const reference of references) {
      if (reference.kind !== "calls") continue
      const source = enclosing(definitions, reference.line) ?? moduleNode
      const candidates = nodesByName(database, projectId, reference.target).filter(
        (node) => node.kind !== MODULE_KIND,
      )
      for (const target of pickCallTargets(candidates, path, imported)) {
        edges.push({
          confidence: target.path === path || imported.has(target.path) ? "extracted" : "inferred",
          fromId: source.id,
          kind: "calls",
          provenance: provenance(),
          toId: target.id,
        })
      }
    }
  }

  insertEdges(database, projectId, edges)
}

/**
 * A name matching definitions in the same file or an imported one is resolved. A name matching only
 * unrelated files is linked solely when exactly one candidate exists; fanning out across every
 * same-named symbol is where a call graph turns into noise on a large repository.
 */
function pickCallTargets(
  candidates: readonly GraphNode[],
  path: string,
  imported: ReadonlySet<string>,
): readonly GraphNode[] {
  const local = candidates.filter((node) => node.path === path || imported.has(node.path))
  if (local.length > 0) return local
  return candidates.length === 1 ? candidates : []
}

function enclosing(nodes: readonly GraphNode[], line: number): GraphNode | undefined {
  let best: GraphNode | undefined
  for (const node of nodes) {
    if (node.startLine > line || node.endLine < line) continue
    if (best === undefined || node.endLine - node.startLine < best.endLine - best.startLine) {
      best = node
    }
  }
  return best
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
]

/** Only project-relative specifiers resolve: a bare package name is an external dependency. */
function resolveImport(
  fromPath: string,
  specifier: string,
  files: ReadonlyMap<string, IndexedFile>,
): string | null {
  if (!specifier.startsWith(".")) return null

  const base = normalize(join(dirname(fromPath), specifier))
  for (const extension of EXTENSIONS) {
    const candidate = normalize(base + extension)
    if (files.has(candidate)) return candidate
    if (extension !== "") {
      const asIndex = normalize(join(base, `index${extension}`))
      if (files.has(asIndex)) return asIndex
    }
  }
  return null
}

async function discover(root: string): Promise<Set<string>> {
  const tracked = await gitFiles(root)
  const files = tracked ?? (await walk(root, root))
  return new Set([...files].filter(isSupported))
}

/** Git's own index is the ignore policy: no second implementation of .gitignore semantics. */
async function gitFiles(root: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      gitArgs(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: false, windowsHide: true },
    )
    return new Set(stdout.split("\0").filter(Boolean).map(normalize))
  } catch {
    return null
  }
}

const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", ".venv"])

async function walk(root: string, directory: string, into = new Set<string>()): Promise<Set<string>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) await walk(root, full, into)
    else if (entry.isFile()) into.add(normalize(relative(root, full)))
  }
  return into
}

async function statOf(path: string): Promise<{ modifiedAt: number; size: number } | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    return { modifiedAt: Math.floor(info.mtimeMs), size: info.size }
  } catch {
    return null
  }
}

async function digestOf(path: string, size?: number): Promise<string | null> {
  try {
    if (size === undefined) {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    }
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
  } catch {
    return null
  }
}

function normalize(path: string): string {
  return path.split(sep).join("/")
}

export type { FileReference }
