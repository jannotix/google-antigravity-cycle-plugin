import assert from "node:assert/strict"
import { test } from "node:test"

import { captureBlocked, captureDelivery, chainOf, explain, forget, recall } from "../src/memory.ts"
import { Database } from "../src/store/database.ts"
import { newId } from "../src/store/ids.ts"
import { insertMemory, memoriesInScope, type CompactMemory } from "../src/store/memory.ts"
import { provenance } from "../src/store/provenance.ts"

const CONTEXT = (database: Database) => ({ database, projectId: "p1" })

function candidate(database: Database, gates: readonly [string, string][]): string {
  const workflowId = newId()
  const candidateId = newId()
  database.run(
    `insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at)
     values (?, 'p1', 'delivery', 5, 1, 1)`,
    workflowId,
  )
  database.run(
    `insert into candidates (id, workflow_id, manifest, diff_digest, candidate_digest, frozen_at)
     values (?, ?, '{}', '', '', 1)`,
    candidateId,
    workflowId,
  )
  for (const [gate, status] of gates) {
    database.run(
      `insert into evidence (
         id, candidate_id, gate_name, kind, status, mandatory, invocation,
         started_at, finished_at, output, output_digest
       ) values (?, ?, ?, 'test', ?, 1, 'x', 0, 0, '', 'd')`,
      newId(),
      candidateId,
      gate,
      status,
    )
  }
  return candidateId
}

function fixture(): { close: () => void; database: Database } {
  const database = new Database({ path: ":memory:" })
  return { close: () => database.close(), database }
}

const titles = (entries: readonly CompactMemory[]): string[] => entries.map((entry) => entry.title).sort()

test("a delivery is remembered with the gates that justify it", () => {
  const { close, database } = fixture()
  try {
    const candidateId = candidate(database, [
      ["test:npm run test", "passed"],
      ["integrity:candidate", "passed"],
    ])

    const written = captureDelivery(CONTEXT(database), {
      candidateId,
      files: ["src/auth/session.ts", "src/auth/login.ts"],
      request: "add oauth login to the dashboard",
      revision: "a".repeat(40),
      workflowId: "w1",
    })

    const entries = explain(CONTEXT(database), written)
    const approval = entries.find((entry) => entry.kind === "approval")!
    assert.equal(approval.title, "add oauth login to the dashboard")
    assert.equal(approval.confidence, "verified")
    assert.equal(approval.provenance.evidenceIds.length, 2)
    assert.deepEqual(approval.scope, ["src/auth"])
    assert.ok(approval.detail.includes("test:npm run test"))
  } finally {
    close()
  }
})

// The gates a project actually passes are knowledge worth keeping current, not accumulating.
test("the project's gates are superseded on each delivery, and the chain remains", () => {
  const { close, database } = fixture()
  try {
    const first = captureDelivery(CONTEXT(database), {
      candidateId: candidate(database, [["test:npm run test", "passed"]]),
      files: ["src/a.ts"],
      request: "first change",
      revision: "a".repeat(40),
      workflowId: "w1",
    })
    const second = captureDelivery(CONTEXT(database), {
      candidateId: candidate(database, [
        ["test:npm run test", "passed"],
        ["lint:npm run lint", "passed"],
      ]),
      files: ["src/b.ts"],
      request: "second change",
      revision: "b".repeat(40),
      workflowId: "w2",
    })

    const current = recall(CONTEXT(database), "gates", ["."])
    const gateEntries = current.filter((entry) => entry.kind === "command")
    assert.equal(gateEntries.length, 1, "only one current gate memory")
    assert.match(gateEntries[0]!.summary, /2 gates verified/u)

    const chain = chainOf(CONTEXT(database), gateEntries[0]!.id)
    assert.equal(chain.length, 2)
    assert.equal(chain[0]?.state, "superseded")
    assert.equal(chain[1]?.state, "current")
    assert.ok(first.length === 2 && second.length === 2)
  } finally {
    close()
  }
})

// Certification 9.2: nothing claims verified without evidence from a gate that passed.
test("a delivery with no passing gate is not remembered as verified", () => {
  const { close, database } = fixture()
  try {
    const candidateId = candidate(database, [["test:npm run test", "failed"]])

    assert.deepEqual(
      captureDelivery(CONTEXT(database), {
        candidateId,
        files: ["src/a.ts"],
        request: "a change",
        revision: "a".repeat(40),
        workflowId: "w1",
      }),
      [],
    )
  } finally {
    close()
  }
})

test("a blocked workflow is remembered as an inferred failed approach", () => {
  const { close, database } = fixture()
  try {
    const candidateId = candidate(database, [
      ["browser:affected-user-flow", "failed"],
      ["integrity:candidate", "passed"],
    ])

    const id = captureBlocked(CONTEXT(database), {
      candidateId,
      cycles: 5,
      files: ["src/components/Banner.tsx"],
      request: "restyle the banner",
      workflowId: "w1",
    })!

    const [entry] = explain(CONTEXT(database), [id])
    assert.equal(entry?.kind, "failed_approach")
    assert.equal(entry?.confidence, "inferred")
    assert.match(entry?.summary ?? "", /blocked after 5 repair cycles/u)
    assert.ok(entry?.detail.includes("browser:affected-user-flow"))
    assert.deepEqual(entry?.scope, ["src/components"])
  } finally {
    close()
  }
})

// Certification 3.8.
test("recall finds a memory by the words in the request and by the area it touches", () => {
  const { close, database } = fixture()
  try {
    captureDelivery(CONTEXT(database), {
      candidateId: candidate(database, [["test:npm run test", "passed"]]),
      files: ["src/auth/session.ts"],
      request: "rotate the session token on privilege change",
      revision: "a".repeat(40),
      workflowId: "w1",
    })

    assert.ok(titles(recall(CONTEXT(database), "session token")).includes(
      "rotate the session token on privilege change",
    ))
    assert.ok(
      titles(recall(CONTEXT(database), "unrelated words", ["src/auth/other.ts"])).includes(
        "rotate the session token on privilege change",
      ),
      "a memory scoped to src/auth is recalled for a change under src/auth",
    )
    assert.equal(
      titles(recall(CONTEXT(database), "unrelated words", ["docs/readme.md"])).includes(
        "rotate the session token on privilege change",
      ),
      false,
    )
  } finally {
    close()
  }
})

// Certification 9.3: the first level is an index, not the content.
test("recall returns a compact index, not detail", () => {
  const { close, database } = fixture()
  try {
    captureDelivery(CONTEXT(database), {
      candidateId: candidate(database, [["test:npm run test", "passed"]]),
      files: ["src/a.ts"],
      request: "a change with a very long detail body",
      revision: "a".repeat(40),
      workflowId: "w1",
    })

    const [entry] = recall(CONTEXT(database), "change")
    assert.ok(entry !== undefined)
    assert.deepEqual(
      Object.keys(entry!).sort(),
      ["confidence", "evidenceCount", "id", "kind", "scope", "summary", "title"],
    )
    assert.ok(!("detail" in entry!))
  } finally {
    close()
  }
})

test("recall is bounded by the requested limit", () => {
  const { close, database } = fixture()
  try {
    for (let index = 0; index < 10; index += 1) {
      insertMemory(
        database,
        {
          confidence: "inferred",
          detail: "detail",
          kind: "convention",
          projectId: "p1",
          provenance: provenance({ revision: "r" }),
          scope: ["."],
          summary: `entry ${index}`,
          title: `convention number ${index}`,
        },
        index,
      )
    }

    assert.equal(recall(CONTEXT(database), "convention", ["."], 3).length, 3)
    assert.equal(memoriesInScope(database, "p1", ["src/a.ts"], 4).length, 4)
  } finally {
    close()
  }
})

// Certification 9.4: revocation stops retrieval and keeps the record.
test("forgetting revokes an entry, keeps it, and needs it to be this project's", () => {
  const { close, database } = fixture()
  try {
    const [id] = captureDelivery(CONTEXT(database), {
      candidateId: candidate(database, [["test:npm run test", "passed"]]),
      files: ["src/a.ts"],
      request: "a forgettable change",
      revision: "a".repeat(40),
      workflowId: "w1",
    })

    const result = forget(CONTEXT(database), id!)
    assert.equal(result.revoked, true)
    assert.equal(titles(recall(CONTEXT(database), "forgettable")).length, 0)
    assert.equal(explain(CONTEXT(database), [id!])[0]?.state, "revoked")

    assert.equal(forget(CONTEXT(database), id!).revoked, false, "a second revocation changes nothing")
    assert.equal(forget({ database, projectId: "p2" }, id!).revoked, false)
  } finally {
    close()
  }
})

test("a memory from another project is never explained or recalled", () => {
  const { close, database } = fixture()
  try {
    const [id] = captureDelivery(CONTEXT(database), {
      candidateId: candidate(database, [["test:npm run test", "passed"]]),
      files: ["src/a.ts"],
      request: "a change",
      revision: "a".repeat(40),
      workflowId: "w1",
    })

    assert.deepEqual(explain({ database, projectId: "p2" }, [id!]), [])
    assert.deepEqual(recall({ database, projectId: "p2" }, "change", ["src/a.ts"]), [])
  } finally {
    close()
  }
})
