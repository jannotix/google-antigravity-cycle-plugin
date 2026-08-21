import type { Role } from "../config.ts"

/**
 * The single provenance shape. A graph edge, a memory entry and a history event all answer "where
 * did this come from" with these fields. A subsystem that invents its own shape is a defect.
 */
export interface Provenance {
  readonly candidateId: string | null
  readonly eventSequence: number | null
  readonly evidenceIds: readonly string[]
  readonly revision: string | null
  readonly role: Role | null
  readonly sessionId: string | null
}

export const UNATTRIBUTED: Provenance = {
  candidateId: null,
  eventSequence: null,
  evidenceIds: [],
  revision: null,
  role: null,
  sessionId: null,
}

export function provenance(partial: Partial<Provenance> = {}): Provenance {
  return { ...UNATTRIBUTED, ...partial }
}

export function serializeProvenance(value: Provenance): string {
  return JSON.stringify(value)
}

export function parseProvenance(value: string): Provenance {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return UNATTRIBUTED
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return UNATTRIBUTED

  const record = parsed as Record<string, unknown>
  return {
    candidateId: text(record["candidateId"]),
    eventSequence: integer(record["eventSequence"]),
    evidenceIds: strings(record["evidenceIds"]),
    revision: text(record["revision"]),
    role: text(record["role"]) as Role | null,
    sessionId: text(record["sessionId"]),
  }
}

/** Provenance that cites no source at all cannot justify a claim. */
export function isAttributed(value: Provenance): boolean {
  return (
    value.candidateId !== null ||
    value.eventSequence !== null ||
    value.evidenceIds.length > 0 ||
    value.revision !== null
  )
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}
