import { createHash, randomUUID } from "node:crypto"

/**
 * Every digest is domain separated, so a value hashed for one purpose can never be replayed as a
 * valid digest for another. Domains are permanent: changing one invalidates persisted digests.
 */
export const DIGEST_DOMAIN = {
  candidate: "cycle/candidate/v1",
  captureCapability: "cycle/capture-capability/v1",
  goal: "cycle/goal-objective/v1",
  historyEntry: "cycle/history-entry/v1",
  output: "cycle/verification-output/v1",
  request: "cycle/request/v1",
  requestAmendment: "cycle/request-amendment/v1",
  verdict: "cycle/verdict/v1",
} as const

export type DigestDomain = (typeof DIGEST_DOMAIN)[keyof typeof DIGEST_DOMAIN]

export function newId(): string {
  return randomUUID()
}

export function digest(domain: DigestDomain, value: unknown): string {
  const payload = Buffer.from(canonicalJson(value), "utf8")
  return createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(lengthPrefix(payload.byteLength))
    .update(payload)
    .digest("hex")
}

export function digestBytes(domain: DigestDomain, bytes: Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(lengthPrefix(bytes.byteLength))
    .update(bytes)
    .digest("hex")
}

/** Stable across key insertion order, so equal values always produce equal digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    )
  }) ?? "null"
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(8)
  prefix.writeBigUInt64BE(BigInt(length))
  return prefix
}
