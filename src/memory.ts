import type { Database } from "./store/database.ts"
import { loadEvidence, type StoredEvidence } from "./store/evidence.ts"
import {
  currentMemoryOfKind,
  insertMemory,
  memoriesInScope,
  memoryChain,
  readMemory,
  revokeMemory,
  searchMemory,
  supersedeMemory,
  type CompactMemory,
  type MemoryEntry,
  type MemoryInput,
} from "./store/memory.ts"
import { provenance } from "./store/provenance.ts"

export interface MemoryContext {
  readonly database: Database
  readonly projectId: string
}

/** The compact index is the first retrieval level; detail is fetched only for what is chosen. */
const RECALL_LIMIT = 12
const GATE_MEMORY_TITLE = "verification gates that pass in this project"
const MAX_DETAIL = 4_000

export interface DeliveredWork {
  readonly candidateId: string
  readonly files: readonly string[]
  readonly request: string
  readonly revision: string
  readonly workflowId: string
}

/**
 * Section 10: project knowledge derived from completed work, linked to the evidence that justifies
 * it. Nothing here is a model's opinion — a delivery happened, these gates passed, these paths
 * changed — so every entry can carry `verified` confidence and name the evidence that earns it.
 */
export function captureDelivery(
  context: MemoryContext,
  work: DeliveredWork,
  now = Date.now(),
): string[] {
  const evidence = loadEvidence(context.database, work.candidateId)
  const passed = evidence.filter((item) => item.status === "passed")
  if (passed.length === 0) return []

  const written: string[] = []
  const scope = scopeOf(work.files)
  const source = provenance({
    candidateId: work.candidateId,
    evidenceIds: passed.map((item) => item.id),
    revision: work.revision,
  })

  written.push(
    insertMemory(
      context.database,
      {
        confidence: "verified",
        detail: bounded(
          [
            `Delivered at ${work.revision}.`,
            "",
            "Files:",
            ...work.files.map((file) => `  ${file}`),
            "",
            "Gates that passed:",
            ...passed.map((item) => `  ${item.gateName}`),
          ].join("\n"),
        ),
        kind: "approval",
        projectId: context.projectId,
        provenance: source,
        scope,
        summary: `${work.files.length} files delivered at ${work.revision.slice(0, 12)} on ${passed.length} recorded gates`,
        title: subjectOf(work.request),
      },
      now,
    ),
  )

  const gates = gateMemory(context, passed, source, work.revision, now)
  if (gates !== null) written.push(gates)
  return written
}

/**
 * What actually verifies this project, kept current rather than accumulated. Superseded on each
 * delivery, so the chain still answers what the gates used to be.
 */
function gateMemory(
  context: MemoryContext,
  passed: readonly StoredEvidence[],
  source: ReturnType<typeof provenance>,
  revision: string,
  now: number,
): string | null {
  const names = [...new Set(passed.map((item) => item.gateName))].sort()
  if (names.length === 0) return null

  const input: MemoryInput = {
    confidence: "verified",
    detail: bounded(["Gates recorded as passing:", ...names.map((name) => `  ${name}`)].join("\n")),
    kind: "command",
    projectId: context.projectId,
    provenance: source,
    scope: ["."],
    summary: `${names.length} gates verified this project as of ${revision.slice(0, 12)}`,
    title: GATE_MEMORY_TITLE,
  }

  const previous = currentMemoryOfKind(context.database, context.projectId, "command", GATE_MEMORY_TITLE)
  return previous === undefined
    ? insertMemory(context.database, input, now)
    : supersedeMemory(context.database, previous, input, now)
}

export interface BlockedWork {
  readonly candidateId: string
  readonly cycles: number
  readonly files: readonly string[]
  readonly request: string
  readonly workflowId: string
}

/**
 * A failed approach is worth more than a successful one: the next architect can avoid it. Recorded
 * as `inferred`, because what blocked is a fact and why it blocked is not.
 */
export function captureBlocked(
  context: MemoryContext,
  work: BlockedWork,
  now = Date.now(),
): string | null {
  const evidence = loadEvidence(context.database, work.candidateId)
  const failed = evidence.filter((item) => item.status !== "passed")
  if (failed.length === 0) return null

  return insertMemory(
    context.database,
    {
      confidence: "inferred",
      detail: bounded(
        [
          `Blocked after ${work.cycles} repair cycles.`,
          "",
          "Gates that did not pass:",
          ...failed.map((item) => `  ${item.gateName}: ${item.status}${item.skipReason === null ? "" : ` — ${item.skipReason}`}`),
          "",
          "Files the attempt touched:",
          ...work.files.map((file) => `  ${file}`),
        ].join("\n"),
      ),
      kind: "failed_approach",
      projectId: context.projectId,
      provenance: provenance({
        candidateId: work.candidateId,
        evidenceIds: failed.map((item) => item.id),
      }),
      scope: scopeOf(work.files),
      summary: `blocked after ${work.cycles} repair cycles on ${failed.map((item) => item.gateName).join(", ")}`,
      title: subjectOf(work.request),
    },
    now,
  )
}

/**
 * Progressive retrieval for a new request: what this project already learned about the words in the
 * request, and about the areas it is going to touch. Compact entries only — detail is a second call
 * for the few that matter.
 */
export function recall(
  context: MemoryContext,
  request: string,
  paths: readonly string[] = [],
  limit = RECALL_LIMIT,
): CompactMemory[] {
  const found = new Map<string, CompactMemory>()
  for (const entry of searchMemory(context.database, context.projectId, request, limit)) {
    found.set(entry.id, entry)
  }
  for (const entry of memoriesInScope(context.database, context.projectId, paths, limit)) {
    if (found.size >= limit) break
    found.set(entry.id, entry)
  }
  return [...found.values()].slice(0, limit)
}

export function explain(context: MemoryContext, ids: readonly string[]): MemoryEntry[] {
  return readMemory(context.database, ids.slice(0, 20)).filter(
    (entry) => entry.projectId === context.projectId,
  )
}

export function forget(
  context: MemoryContext,
  id: string,
  now = Date.now(),
): { chain: ReturnType<typeof memoryChain>; revoked: boolean } {
  const owned = explain(context, [id]).length === 1
  return {
    chain: memoryChain(context.database, id),
    revoked: owned && revokeMemory(context.database, id, now),
  }
}

export function chainOf(context: MemoryContext, id: string): ReturnType<typeof memoryChain> {
  return memoryChain(context.database, id)
}

/** Directories, so a memory about `src/auth/session.ts` is recalled for anything under `src/auth`. */
function scopeOf(files: readonly string[]): string[] {
  const directories = new Set<string>()
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/")
    const cut = normalized.lastIndexOf("/")
    directories.add(cut === -1 ? "." : normalized.slice(0, cut))
  }
  const scope = [...directories].sort().slice(0, 20)
  return scope.length === 0 ? ["."] : scope
}

function subjectOf(request: string): string {
  const first = request.trim().split(/\r?\n/u)[0]?.trim() ?? "delivered work"
  return first.length > 120 ? `${first.slice(0, 117)}...` : first || "delivered work"
}

function bounded(detail: string): string {
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 3)}...` : detail
}
