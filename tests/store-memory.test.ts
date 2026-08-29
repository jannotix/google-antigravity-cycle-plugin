import assert from "node:assert/strict"
import { test } from "node:test"

import { Database } from "../src/store/database.ts"
import {
  MemoryRejected,
  insertMemory,
  readMemory,
  searchMemory,
  supersedeMemory,
  type MemoryInput,
} from "../src/store/memory.ts"
import { provenance } from "../src/store/provenance.ts"

function store(): Database {
  return new Database({ path: ":memory:" })
}

const entry = (overrides: Partial<MemoryInput> = {}): MemoryInput => ({
  confidence: "inferred",
  detail: "The billing router mounts under /api/billing and requires an organisation scope.",
  kind: "convention",
  projectId: "p1",
  provenance: provenance({ revision: "abc123" }),
  scope: ["src/billing"],
  summary: "Billing routes require an organisation scope",
  title: "Billing route scoping",
  ...overrides,
})

test("a memory round trips with its provenance", () => {
  const database = store()

  const id = insertMemory(
    database,
    entry({ provenance: provenance({ candidateId: "c1", evidenceIds: ["e1"], revision: "abc" }) }),
    1_000,
  )
  const [stored] = readMemory(database, [id])

  assert.equal(stored?.title, "Billing route scoping")
  assert.equal(stored?.state, "current")
  assert.equal(stored?.provenance.candidateId, "c1")
  assert.deepEqual(stored?.provenance.evidenceIds, ["e1"])
  assert.deepEqual(stored?.scope, ["src/billing"])
  database.close()
})

test("full-text search finds an entry by a word from any indexed field", () => {
  const database = store()
  insertMemory(database, entry(), 1)
  insertMemory(
    database,
    entry({
      detail: "Schema changes are applied by the release task, never on startup.",
      summary: "Migrations run through the release task",
      title: "Migration ordering",
    }),
    2,
  )

  assert.equal(searchMemory(database, "p1", "billing", 10).length, 1)
  assert.equal(searchMemory(database, "p1", "migrations", 10).length, 1)
  assert.equal(searchMemory(database, "p1", "organisation", 10).length, 1)
  database.close()
})

// The compact level is what a role sees first; detail is fetched only for what it selects.
test("search returns the compact level without the detail field", () => {
  const database = store()
  insertMemory(database, entry(), 1)

  const [compact] = searchMemory(database, "p1", "billing", 10)

  assert.ok(compact)
  assert.equal(Object.hasOwn(compact, "detail"), false)
  assert.equal(compact.title, "Billing route scoping")
  database.close()
})

test("search is scoped to one project", () => {
  const database = store()
  insertMemory(database, entry({ projectId: "p1" }), 1)
  insertMemory(database, entry({ projectId: "p2" }), 2)

  assert.equal(searchMemory(database, "p1", "billing", 10).length, 1)
  database.close()
})

test("punctuation in a query does not break the match expression", () => {
  const database = store()
  insertMemory(database, entry(), 1)

  assert.doesNotThrow(() => searchMemory(database, "p1", 'billing" OR *', 10))
  assert.equal(searchMemory(database, "p1", "!!!", 10).length, 0)
  database.close()
})

// Certification 9.1.
test("a memory without an applicability scope is refused", () => {
  const database = store()

  assert.throws(() => insertMemory(database, entry({ scope: [] }), 1), MemoryRejected)
  database.close()
})

// Certification 9.1.
test("a memory that cites no source is refused", () => {
  const database = store()

  assert.throws(() => insertMemory(database, entry({ provenance: provenance() }), 1), MemoryRejected)
  database.close()
})

test("verified confidence requires evidence, not just a revision", () => {
  const database = store()

  assert.throws(
    () => insertMemory(database, entry({ confidence: "verified" }), 1),
    /verified confidence requires evidence/u,
  )
  assert.doesNotThrow(() =>
    insertMemory(
      database,
      entry({ confidence: "verified", provenance: provenance({ evidenceIds: ["e1"] }) }),
      1,
    ),
  )
  database.close()
})

// Certification 9.5.
test("a memory carrying a secret is refused", () => {
  const database = store()

  assert.throws(
    () => insertMemory(database, entry({ detail: "use sk-ant-abcdefghijklmnopqrstuvwxyz012345" }), 1),
    /cannot contain a secret/u,
  )
  database.close()
})

test("superseding preserves the previous entry and links the chain", () => {
  const database = store()
  const original = insertMemory(database, entry(), 1)

  const replacement = supersedeMemory(
    database,
    original,
    entry({ summary: "Billing routes now require a workspace scope" }),
    2,
  )

  const [previous] = readMemory(database, [original])
  assert.equal(previous?.state, "superseded")
  assert.equal(previous?.supersededBy, replacement)
  assert.equal(searchMemory(database, "p1", "billing", 10).length, 1)
  database.close()
})

test("a superseded entry no longer appears in search but is still readable", () => {
  const database = store()
  const original = insertMemory(database, entry(), 1)
  supersedeMemory(database, original, entry({ title: "Billing route scoping v2" }), 2)

  const found = searchMemory(database, "p1", "billing", 10)

  assert.equal(found.length, 1)
  assert.notEqual(found[0]?.id, original)
  assert.equal(readMemory(database, [original]).length, 1)
  database.close()
})
