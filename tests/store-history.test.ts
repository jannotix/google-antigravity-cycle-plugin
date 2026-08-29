import assert from "node:assert/strict"
import { test } from "node:test"

import { Database } from "../src/store/database.ts"
import { appendHistory, readHistory, verifyHistory } from "../src/store/history.ts"

function store(): Database {
  return new Database({ path: ":memory:" })
}

const event = (action: string, projectId = "p1") => ({
  action,
  actor: "cycle",
  projectId,
})

test("entries form a contiguous chain, each committing to its predecessor", () => {
  const database = store()

  const first = appendHistory(database, event("workflow.started"), 1_000)
  const second = appendHistory(database, event("candidate.frozen"), 2_000)

  assert.equal(first.sequence, 0)
  assert.equal(first.previousHash, null)
  assert.equal(second.sequence, 1)
  assert.equal(second.previousHash, first.hash)
  assert.notEqual(first.hash, second.hash)
  database.close()
})

test("verification accepts an intact chain and reports the head", () => {
  const database = store()
  appendHistory(database, event("a"), 1)
  const last = appendHistory(database, event("b"), 2)

  const result = verifyHistory(database)

  assert.equal(result.valid, true)
  assert.equal(result.valid && result.entries, 2)
  assert.equal(result.valid && result.head, last.hash)
  database.close()
})

test("history rejects updates and deletes at the database level", () => {
  const database = store()
  appendHistory(database, event("a"), 1)

  assert.throws(() => database.run("update history set action = 'b' where sequence = 0"), /append-only/u)
  assert.throws(() => database.run("delete from history where sequence = 0"), /append-only/u)
  database.close()
})

// The triggers block the supported path, so tampering is simulated the way an attacker with direct
// file access would: by rewriting the row after dropping the guard.
// Certification 7.6.
test("a rewritten entry is detected by hash verification", () => {
  const database = store()
  appendHistory(database, event("a"), 1)
  appendHistory(database, event("b"), 2)

  database.run("drop trigger history_is_append_only_update")
  database.run(
    "update history set event = json_set(event, '$.action', 'tampered') where sequence = 1",
  )

  const result = verifyHistory(database)
  assert.equal(result.valid, false)
  assert.equal(!result.valid && result.reason, "hash")
  assert.equal(!result.valid && result.sequence, 1)
  database.close()
})

// The indexed columns are a query convenience, not the record. Rewriting one must not change what a
// reader sees, otherwise tampering would be invisible to chain verification.
test("rewriting a denormalized column does not change what is read back", () => {
  const database = store()
  appendHistory(database, event("candidate.frozen"), 1)

  database.run("drop trigger history_is_append_only_update")
  database.run("update history set action = 'tampered', role = 'arbiter' where sequence = 0")

  const [stored] = readHistory(database, "p1", null, 1)
  assert.equal(stored?.action, "candidate.frozen")
  assert.equal(stored?.role, null)
  assert.equal(verifyHistory(database).valid, true)
  database.close()
})

// Certification 7.6.
test("a removed entry is detected as a sequence gap", () => {
  const database = store()
  appendHistory(database, event("a"), 1)
  appendHistory(database, event("b"), 2)
  appendHistory(database, event("c"), 3)

  database.run("drop trigger history_is_append_only_delete")
  database.run("delete from history where sequence = 1")

  const result = verifyHistory(database)
  assert.equal(result.valid, false)
  assert.equal(!result.valid && result.reason, "sequence")
  database.close()
})

test("reading is scoped to a project while the chain stays global", () => {
  const database = store()
  appendHistory(database, event("a", "p1"), 1)
  appendHistory(database, event("b", "p2"), 2)
  appendHistory(database, event("c", "p1"), 3)

  const first = readHistory(database, "p1", null, 10)

  assert.deepEqual(first.map((entry) => entry.action), ["a", "c"])
  assert.deepEqual(first.map((entry) => entry.sequence), [0, 2])
  assert.equal(verifyHistory(database).valid, true)
  database.close()
})

test("reading continues from a sequence cursor", () => {
  const database = store()
  appendHistory(database, event("a"), 1)
  appendHistory(database, event("b"), 2)
  appendHistory(database, event("c"), 3)

  const page = readHistory(database, "p1", 0, 10)

  assert.deepEqual(page.map((entry) => entry.action), ["b", "c"])
  database.close()
})

// Certification 7.10.
test("an entry records the actor, role, session and files it touched", () => {
  const database = store()

  const entry = appendHistory(
    database,
    {
      action: "execution.task_completed",
      actor: "agent",
      candidateId: "c1",
      evidenceIds: ["e1", "e2"],
      files: ["src/a.ts"],
      metadata: { revision: "abc123" },
      projectId: "p1",
      role: "executor",
      sessionId: "s1",
      workflowId: "w1",
    },
    5_000,
  )

  const [stored] = readHistory(database, "p1", null, 1)
  assert.equal(stored?.role, "executor")
  assert.equal(stored?.sessionId, "s1")
  assert.deepEqual(stored?.files, ["src/a.ts"])
  assert.deepEqual(stored?.evidenceIds, ["e1", "e2"])
  assert.equal(stored?.metadata["revision"], "abc123")
  assert.equal(stored?.hash, entry.hash)
  database.close()
})

// Certification 7.8.
test("a secret in metadata is redacted before it reaches the chain", () => {
  const database = store()

  appendHistory(
    database,
    { ...event("tool.invoked"), metadata: { command: "deploy --key sk-ant-abcdefghijklmnopqrstuvwxyz012345" } },
    1,
  )

  const [stored] = readHistory(database, "p1", null, 1)
  assert.match(stored?.metadata["command"] ?? "", /\[redacted:anthropic-key\]/u)
  assert.doesNotMatch(stored?.metadata["command"] ?? "", /sk-ant-abcdefg/u)
  assert.equal(verifyHistory(database).valid, true)
  database.close()
})
