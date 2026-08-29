import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"

import { Database, StoreError } from "../src/store/database.ts"
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../src/store/migrations.ts"

function temporaryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "cycle-store-")), "store.db")
}

test("migration versions are unique, ordered and contiguous from one", () => {
  const versions = MIGRATIONS.map((migration) => migration.version)

  assert.deepEqual(versions, [...versions].sort((left, right) => left - right))
  assert.equal(new Set(versions).size, versions.length)
  assert.deepEqual(versions, versions.map((_value, index) => index + 1))
  assert.equal(CURRENT_SCHEMA_VERSION, versions.at(-1))
})

test("an empty database migrates to the current schema version", () => {
  const database = new Database({ path: ":memory:" })

  assert.equal(database.mode, "read_write")
  assert.equal(database.schemaVersion, CURRENT_SCHEMA_VERSION)
  database.close()
})

// Certification 1.10, 1.12.
test("reopening an existing store applies nothing and preserves data", () => {
  const path = temporaryPath()
  try {
    const first = new Database({ path })
    first.run(
      "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w1','p',?,5,1,1)",
      "intake",
    )
    first.close()

    const second = new Database({ path })
    assert.equal(second.schemaVersion, CURRENT_SCHEMA_VERSION)
    assert.equal(second.get("select state from workflows where id = 'w1'")?.["state"], "intake")
    second.close()
  } finally {
    rmSync(join(path, ".."), { force: true, recursive: true })
  }
})

// An older build must never migrate a newer store downward, so it opens read-only instead.
// Certification 7.9.
test("a store from a newer schema opens read-only and refuses writes", () => {
  const path = temporaryPath()
  try {
    const seed = new DatabaseSync(path)
    seed.exec(`pragma user_version = ${CURRENT_SCHEMA_VERSION + 1}`)
    seed.close()

    const database = new Database({ path })
    assert.equal(database.mode, "safe_read_only")
    assert.equal(database.schemaVersion, CURRENT_SCHEMA_VERSION + 1)
    assert.throws(() => database.run("create table nope (a text)"), StoreError)
    database.close()
  } finally {
    rmSync(join(path, ".."), { force: true, recursive: true })
  }
})

test("the original request cannot be rewritten once recorded", () => {
  const database = new Database({ path: ":memory:" })
  database.run(
    "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w1','p','intake',5,1,1)",
  )
  database.run(
    "insert into requests (workflow_id, original_text, digest, created_at) values ('w1', ?, 'd', 1)",
    "add organisation billing",
  )

  assert.throws(
    () => database.run("update requests set original_text = 'something else' where workflow_id = 'w1'"),
    /immutable/u,
  )
  assert.equal(
    database.get("select original_text from requests where workflow_id = 'w1'")?.["original_text"],
    "add organisation billing",
  )
  database.close()
})

test("amendments are appended without touching the original text", () => {
  const database = new Database({ path: ":memory:" })
  database.run(
    "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w1','p','intake',5,1,1)",
  )
  database.run(
    "insert into requests (workflow_id, original_text, digest, created_at) values ('w1','original','d',1)",
  )
  database.run(
    "update requests set amendments = ? where workflow_id = 'w1'",
    JSON.stringify([{ receivedAt: 2, sequence: 1, text: "also invoice PDFs" }]),
  )

  const row = database.get("select original_text, amendments from requests where workflow_id = 'w1'")
  assert.equal(row?.["original_text"], "original")
  assert.equal(JSON.parse(String(row?.["amendments"])).length, 1)
  database.close()
})

test("a delivery round trip survives across every related table", () => {
  const database = new Database({ path: ":memory:" })

  database.transaction(() => {
    database.run(
      "insert into workflows (id, project_id, state, mode, max_repair_cycles, created_at, updated_at) values ('w1','p','execution','full',5,1,1)",
    )
    database.run(
      "insert into requests (workflow_id, original_text, digest, created_at) values ('w1','build billing','d',1)",
    )
    database.run(
      `insert into tasks (id, workflow_id, task_key, title, objective, state, position, write_scopes, created_at, updated_at)
       values ('t1','w1','task-1','Add endpoint','Expose billing','completed',0,?,1,1)`,
      JSON.stringify(["src/billing"]),
    )
    database.run(
      "insert into candidates (id, workflow_id, base_revision, manifest, diff_digest, candidate_digest, frozen_at) values ('c1','w1','abc','{}','dd','cd',2)",
    )
    database.run(
      "insert into candidate_files (candidate_id, path, kind, digest) values ('c1','src/billing/index.ts','added','fd')",
    )
    database.run(
      `insert into evidence (id, candidate_id, gate_name, kind, status, mandatory, invocation, exit_code, started_at, finished_at, output_digest)
       values ('e1','c1','test:npm test','test','passed',1,'npm test',0,2,3,'od')`,
    )
    database.run(
      "insert into reviews (id, workflow_id, candidate_id, role, verdict, verdict_digest, submitted_at) values ('r1','w1','c1','functional_reviewer','{}','vd',4)",
    )
    database.run(
      "insert into arbitrations (id, workflow_id, candidate_id, decision, verdict, receipt, receipt_digest, finalized_at) values ('a1','w1','c1','approved','{}','{}','rd',5)",
    )
  })

  assert.equal(database.all("select id from tasks where workflow_id = 'w1'").length, 1)
  assert.equal(database.get("select status from evidence where id = 'e1'")?.["status"], "passed")
  assert.equal(database.get("select decision from arbitrations where id = 'a1'")?.["decision"], "approved")
  database.close()
})

test("deleting a workflow removes everything that depends on it", () => {
  const database = new Database({ path: ":memory:" })
  database.transaction(() => {
    database.run(
      "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w1','p','intake',5,1,1)",
    )
    database.run(
      "insert into candidates (id, workflow_id, manifest, diff_digest, candidate_digest, frozen_at) values ('c1','w1','{}','d','c',1)",
    )
    database.run(
      `insert into evidence (id, candidate_id, gate_name, kind, status, mandatory, invocation, started_at, finished_at, output_digest)
       values ('e1','c1','g','test','passed',1,'x',1,2,'o')`,
    )
  })

  database.run("delete from workflows where id = 'w1'")

  assert.equal(database.all("select id from candidates").length, 0)
  assert.equal(database.all("select id from evidence").length, 0)
  database.close()
})

test("a foreign key that points nowhere is refused", () => {
  const database = new Database({ path: ":memory:" })

  assert.throws(() =>
    database.run(
      "insert into candidates (id, workflow_id, manifest, diff_digest, candidate_digest, frozen_at) values ('c1','missing','{}','d','c',1)",
    ),
  )
  database.close()
})

test("a nested transaction joins the outer one instead of failing", () => {
  const database = new Database({ path: ":memory:" })

  database.transaction(() => {
    database.run(
      "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w1','p','intake',5,1,1)",
    )
    database.transaction(() => {
      database.run(
        "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w2','p','intake',5,1,1)",
      )
    })
  })

  assert.equal(database.all("select id from workflows").length, 2)
  database.close()
})

test("a failed inner transaction rolls back only its own work", () => {
  const database = new Database({ path: ":memory:" })

  database.transaction(() => {
    database.run(
      "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w1','p','intake',5,1,1)",
    )
    assert.throws(() =>
      database.transaction(() => {
        database.run(
          "insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at) values ('w2','p','intake',5,1,1)",
        )
        throw new Error("inner failure")
      }),
    )
  })

  const ids = database.all<{ id: string }>("select id from workflows").map((row) => row.id)
  assert.deepEqual(ids, ["w1"])
  database.close()
})
