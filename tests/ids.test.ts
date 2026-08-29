import assert from "node:assert/strict"
import { test } from "node:test"

import { DIGEST_DOMAIN, canonicalJson, digest, digestBytes, newId } from "../src/store/ids.ts"
import { UNATTRIBUTED, isAttributed, parseProvenance, provenance } from "../src/store/provenance.ts"

test("canonical form is independent of key order", () => {
  assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
})

test("canonical form preserves array order", () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
})

test("equal values digest equally regardless of key order", () => {
  assert.equal(
    digest(DIGEST_DOMAIN.request, { text: "x", attachments: [] }),
    digest(DIGEST_DOMAIN.request, { attachments: [], text: "x" }),
  )
})

// Without domain separation, a digest computed for one purpose could be replayed as another.
test("the same value digests differently under different domains", () => {
  assert.notEqual(
    digest(DIGEST_DOMAIN.request, { text: "x" }),
    digest(DIGEST_DOMAIN.verdict, { text: "x" }),
  )
})

test("length prefixing prevents adjacent fields from colliding", () => {
  assert.notEqual(
    digest(DIGEST_DOMAIN.request, ["ab", "c"]),
    digest(DIGEST_DOMAIN.request, ["a", "bc"]),
  )
})

test("a digest is a lowercase sha-256 hex string", () => {
  assert.match(digest(DIGEST_DOMAIN.candidate, {}), /^[0-9a-f]{64}$/u)
  assert.match(digestBytes(DIGEST_DOMAIN.output, new Uint8Array([1, 2, 3])), /^[0-9a-f]{64}$/u)
})

test("identifiers are unique", () => {
  const ids = new Set(Array.from({ length: 500 }, newId))

  assert.equal(ids.size, 500)
})

test("provenance defaults to unattributed", () => {
  assert.equal(isAttributed(provenance()), false)
  assert.equal(isAttributed(provenance({ sessionId: "s1" })), false)
  assert.equal(isAttributed(provenance({ evidenceIds: ["e1"] })), true)
  assert.equal(isAttributed(provenance({ revision: "abc" })), true)
})

test("provenance survives a serialise and parse round trip", () => {
  const original = provenance({
    candidateId: "c1",
    eventSequence: 4,
    evidenceIds: ["e1", "e2"],
    revision: "abc",
    role: "executor",
    sessionId: "s1",
  })

  assert.deepEqual(parseProvenance(JSON.stringify(original)), original)
})

test("malformed provenance parses to unattributed rather than throwing", () => {
  assert.deepEqual(parseProvenance("not json"), UNATTRIBUTED)
  assert.deepEqual(parseProvenance("[1,2]"), UNATTRIBUTED)
  assert.deepEqual(parseProvenance('{"evidenceIds":"not-an-array"}'), UNATTRIBUTED)
})
