import type { Database } from "../store/database.ts"
import { nodesByName, nodesInFiles } from "../store/graph.ts"
import type { ChangedFile } from "./changes.ts"

export interface Duplicate {
  readonly addedIn: string
  readonly existsIn: string
  readonly kind: string
  readonly name: string
}

/**
 * Only top-level definitions. Two classes may legitimately have a `render` method; two files
 * defining the same exported function are the reimplementation the essentiality ladder exists to
 * prevent.
 */
const DEFINITION_KINDS = new Set(["class", "component", "function", "interface", "type"])

const MIN_NAME_LENGTH = 4

// Names that collide everywhere carry no signal, and a detector that fires on them is one people
// learn to ignore.
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
])

/**
 * The essentiality gate, run against the code graph rather than a model: a capability that already
 * exists somewhere else in the project and is defined again in a file this candidate added is a
 * finding for the functional reviewer to score.
 */
export function reimplementedCapabilities(
  database: Database,
  projectId: string,
  changed: readonly ChangedFile[],
): Duplicate[] {
  const addedPaths = changed.filter((file) => file.kind === "added").map((file) => file.path)
  if (addedPaths.length === 0) return []

  const added = new Set(addedPaths)
  const duplicates: Duplicate[] = []
  const seen = new Set<string>()

  for (const node of nodesInFiles(database, projectId, addedPaths)) {
    if (!DEFINITION_KINDS.has(node.kind)) continue
    if (node.name.length < MIN_NAME_LENGTH) continue
    if (COMMON_NAMES.has(node.name.toLowerCase())) continue
    if (seen.has(node.name)) continue

    const elsewhere = nodesByName(database, projectId, node.name).filter(
      (other) => !added.has(other.path) && DEFINITION_KINDS.has(other.kind),
    )
    // Exactly one prior definition is a capability. Several are a common name.
    if (elsewhere.length !== 1) continue

    seen.add(node.name)
    duplicates.push({
      addedIn: node.path,
      existsIn: elsewhere[0]!.path,
      kind: node.kind,
      name: node.name,
    })
  }

  return duplicates
}
