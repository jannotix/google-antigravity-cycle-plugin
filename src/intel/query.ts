import type { Database } from "../store/database.ts"
import {
  neighbours,
  nodesByName,
  nodesInFiles,
  type GraphNode,
  type Neighbour,
} from "../store/graph.ts"

const DEFAULT_BUDGET_BYTES = 64 * 1024

export interface ContextBundle {
  readonly nodes: readonly GraphNode[]
  readonly paths: readonly string[]
  /** True when the budget cut the result: the caller is told, never silently given less. */
  readonly truncated: boolean
}

export function neighboursOf(
  database: Database,
  nodeId: string,
  depth: number,
): { edges: Neighbour[]; visited: string[] } {
  const seen = new Set([nodeId])
  const edges: Neighbour[] = []
  let frontier = [nodeId]

  for (let level = 0; level < Math.max(1, Math.min(depth, 4)); level += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of neighbours(database, id)) {
        edges.push(neighbour)
        if (seen.has(neighbour.node.id)) continue
        seen.add(neighbour.node.id)
        next.push(neighbour.node.id)
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  return { edges, visited: [...seen] }
}

/** What a change to these files can reach: the incoming side of the graph, transitively. */
export function impactOf(
  database: Database,
  projectId: string,
  paths: readonly string[],
  depth = 2,
): GraphNode[] {
  const seeds = nodesInFiles(database, projectId, paths)
  const seen = new Set(seeds.map((node) => node.id))
  const reached = new Map<string, GraphNode>()
  let frontier = seeds.map((node) => node.id)

  for (let level = 0; level < Math.max(1, Math.min(depth, 4)); level += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of neighbours(database, id)) {
        if (neighbour.direction !== "incoming" || seen.has(neighbour.node.id)) continue
        seen.add(neighbour.node.id)
        reached.set(neighbour.node.id, neighbour.node)
        next.push(neighbour.node.id)
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  return [...reached.values()]
}

export function findSymbol(database: Database, projectId: string, name: string): GraphNode[] {
  return nodesByName(database, projectId, name)
}

/**
 * A bounded slice for a role prompt. The graph is never handed to a model whole: a caller asks for
 * the neighbourhood of some files and gets as much as the budget allows, with truncation reported.
 */
export function scopeBundle(
  database: Database,
  projectId: string,
  paths: readonly string[],
  budgetBytes = DEFAULT_BUDGET_BYTES,
): ContextBundle {
  const direct = nodesInFiles(database, projectId, paths)
  const related = impactOf(database, projectId, paths, 1)
  const ordered = [...direct, ...related.filter((node) => !paths.includes(node.path))]

  const nodes: GraphNode[] = []
  let used = 0
  let truncated = false
  for (const node of ordered) {
    const size = JSON.stringify(node).length
    if (used + size > budgetBytes) {
      truncated = true
      break
    }
    used += size
    nodes.push(node)
  }

  return {
    nodes,
    paths: [...new Set(nodes.map((node) => node.path))],
    truncated,
  }
}
