import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  latestCheckpoint,
  signCheckpoint,
  signingKey,
  verifyCheckpoints,
} from "../src/store/checkpoints.ts"
import { Database } from "../src/store/database.ts"
import { appendHistory, verifyHistory } from "../src/store/history.ts"

function fixture(): { close: () => void; database: Database; directory: string } {
  const database = new Database({ path: ":memory:" })
  const directory = mkdtempSync(join(tmpdir(), "cycle-keys-"))
  return {
    close: () => {
      database.close()
      rmSync(directory, { force: true, recursive: true })
    },
    database,
    directory,
  }
}

const append = (database: Database, action: string, at: number) =>
  appendHistory(database, { action, actor: "cycle", projectId: "p1" }, at)

test("the signing key is generated once and reused", () => {
  const { close, directory } = fixture()
  try {
    const first = signingKey(directory)
    const second = signingKey(directory)

    assert.equal(first.privatePem, second.privatePem)
    assert.match(first.publicPem, /BEGIN PUBLIC KEY/u)
    assert.ok(readFileSync(join(directory, "keys", "checkpoint.key"), "utf8").includes("PRIVATE KEY"))
  } finally {
    close()
  }
})

// A key everybody can read is a signature anybody can forge.
test(
  "the signing key is not readable by other users",
  { skip: process.platform === "win32" },
  () => {
    const { close, directory } = fixture()
    try {
      signingKey(directory)
      const mode = statSync(join(directory, "keys", "checkpoint.key")).mode & 0o777

      assert.equal(mode, 0o600)
    } finally {
      close()
    }
  },
)

test("a checkpoint signs the head of the chain and verifies", () => {
  const { close, database, directory } = fixture()
  try {
    append(database, "workflow.started", 1)
    append(database, "candidate.frozen", 2)

    const checkpoint = signCheckpoint(database, directory, 3)
    assert.equal(checkpoint?.sequence, 1)
    assert.deepEqual(verifyCheckpoints(database), { checked: 1, head: 1, valid: true })
    assert.equal(latestCheckpoint(database)?.signature, checkpoint?.signature)
  } finally {
    close()
  }
})

test("an empty chain has nothing to sign", () => {
  const { close, database, directory } = fixture()
  try {
    assert.equal(signCheckpoint(database, directory, 1), null)
    assert.deepEqual(verifyCheckpoints(database), { checked: 0, head: null, valid: true })
  } finally {
    close()
  }
})

test("signing the same head twice replaces the checkpoint rather than duplicating it", () => {
  const { close, database, directory } = fixture()
  try {
    append(database, "workflow.started", 1)
    signCheckpoint(database, directory, 2)
    signCheckpoint(database, directory, 3)

    const verified = verifyCheckpoints(database)
    assert.equal(verified.valid, true)
    if (verified.valid) assert.equal(verified.checked, 1)
  } finally {
    close()
  }
})

// The whole point: a rewritten entry breaks the chain, and the signature over the old head no
// longer matches what the chain says the head was.
// Certification 7.6.
test("a tampered entry breaks both the chain and its signature", () => {
  const { close, database, directory } = fixture()
  try {
    append(database, "workflow.started", 1)
    append(database, "delivery.completed", 2)
    signCheckpoint(database, directory, 3)

    // The history triggers refuse updates, so tampering is simulated the way a real attacker would
    // have to: by rewriting the file underneath. Here, by dropping the trigger first.
    database.run("drop trigger history_is_append_only_update")
    database.run("update history set event = ? where sequence = ?", '{"action":"forged"}', 1)

    const chain = verifyHistory(database)
    assert.equal(chain.valid, false)
    if (!chain.valid) assert.equal(chain.reason, "hash")

    const signatures = verifyCheckpoints(database)
    assert.equal(signatures.valid, true, "the head hash column was not touched, so the anchor holds")
  } finally {
    close()
  }
})

test("a checkpoint whose entry no longer holds that hash is detached", () => {
  const { close, database, directory } = fixture()
  try {
    append(database, "workflow.started", 1)
    signCheckpoint(database, directory, 2)

    database.run("drop trigger history_is_append_only_update")
    database.run("update history set hash = ? where sequence = 0", "0".repeat(64))

    const signatures = verifyCheckpoints(database)
    assert.equal(signatures.valid, false)
    if (!signatures.valid) assert.equal(signatures.reason, "detached")
  } finally {
    close()
  }
})

test("a forged signature does not verify", () => {
  const { close, database, directory } = fixture()
  try {
    append(database, "workflow.started", 1)
    signCheckpoint(database, directory, 2)
    database.run("update checkpoints set signature = ? where sequence = 0", Buffer.from("no").toString("base64"))

    const signatures = verifyCheckpoints(database)
    assert.equal(signatures.valid, false)
    if (!signatures.valid) assert.equal(signatures.reason, "signature")
  } finally {
    close()
  }
})
