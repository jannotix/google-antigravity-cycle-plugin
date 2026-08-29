import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { indexProject } from "../src/intel/indexer.ts"
import { impactOf, scopeBundle } from "../src/intel/query.ts"
import { ParsePool } from "../src/intel/pool.ts"
import { Database } from "../src/store/database.ts"
import { graphSize, indexedFiles, neighbours, nodesByName } from "../src/store/graph.ts"

const PROJECT = "p1"

async function fixture(files: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "cycle-intel-"))
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, "utf8")
  }
  return root
}

// One pool for the suite: loading a grammar costs about a second per language per thread.
const pool = new ParsePool(2)
test.after(() => pool.dispose())

const index = (database: Database, root: string) =>
  indexProject(database, PROJECT, root, { pool })

// Certification 8.1, 8.3.
test("a first pass indexes every supported file and skips the rest", async () => {
  const root = await fixture({
    "README.md": "# not code",
    "src/a.ts": `export function alpha() { return 1 }`,
    "src/b.py": `def beta():\n    return 2`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    const report = await index(database, root)

    assert.equal(report.files, 2)
    assert.equal(report.updated, 2)
    assert.equal(report.unchanged, 0)
    assert.deepEqual([...indexedFiles(database, PROJECT).keys()].sort(), ["src/a.ts", "src/b.py"])
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// This is the property that makes a large repository affordable on every pass after the first.
// Certification 8.2.
test("a second pass reparses nothing when no bytes changed", async () => {
  const root = await fixture({ "src/a.ts": `export function alpha() { return 1 }` })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const second = await index(database, root)

    assert.equal(second.unchanged, 1)
    assert.equal(second.updated, 0)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Certification 8.2.
test("editing one file reparses only that file", async () => {
  const root = await fixture({
    "src/a.ts": `export function alpha() { return 1 }`,
    "src/b.ts": `export function beta() { return 2 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    await writeFile(join(root, "src/a.ts"), `export function alpha() { return 99 }`, "utf8")
    const second = await index(database, root)

    assert.equal(second.updated, 1)
    assert.equal(second.unchanged, 1)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test("a deleted file loses its nodes and its index entry", async () => {
  const root = await fixture({
    "src/a.ts": `export function alpha() { return 1 }`,
    "src/b.ts": `export function beta() { return 2 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    rmSync(join(root, "src/b.ts"))
    const second = await index(database, root)

    assert.equal(second.removed, 1)
    assert.equal(nodesByName(database, PROJECT, "beta").length, 0)
    assert.equal(indexedFiles(database, PROJECT).has("src/b.ts"), false)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test("renaming a symbol leaves no trace of the old one", async () => {
  const root = await fixture({ "src/a.ts": `export function alpha() { return 1 }` })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    await writeFile(join(root, "src/a.ts"), `export function renamed() { return 1 }`, "utf8")
    await index(database, root)

    assert.equal(nodesByName(database, PROJECT, "alpha").length, 0)
    assert.equal(nodesByName(database, PROJECT, "renamed").length, 1)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test("a relative import becomes an edge between the two module nodes", async () => {
  const root = await fixture({
    "src/a.ts": `import { beta } from "./b"\nexport function alpha() { return beta() }`,
    "src/b.ts": `export function beta() { return 2 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)

    const [moduleA] = nodesByName(database, PROJECT, "src/a.ts")
    const imports = neighbours(database, moduleA!.id).filter((edge) => edge.edge === "imports")

    assert.equal(imports.length, 1)
    assert.equal(imports[0]?.node.name, "src/b.ts")
    assert.equal(imports[0]?.confidence, "extracted")
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test("a bare package specifier produces no edge", async () => {
  const root = await fixture({ "src/a.ts": `import { x } from "lodash"\nexport const y = x` })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const [moduleA] = nodesByName(database, PROJECT, "src/a.ts")

    assert.equal(neighbours(database, moduleA!.id).filter((e) => e.edge === "imports").length, 0)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Certification 8.5.
test("a call into an imported file resolves as extracted", async () => {
  const root = await fixture({
    "src/a.ts": `import { beta } from "./b"\nexport function alpha() { return beta() }`,
    "src/b.ts": `export function beta() { return 2 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const [alpha] = nodesByName(database, PROJECT, "alpha")
    const calls = neighbours(database, alpha!.id).filter((edge) => edge.edge === "calls")

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.node.name, "beta")
    assert.equal(calls[0]?.confidence, "extracted")
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Precision over recall: linking every same-named symbol is how a call graph becomes noise.
test("an ambiguous name in unrelated files produces no call edge", async () => {
  const root = await fixture({
    "src/a.ts": `export function alpha() { return handle() }`,
    "src/b.ts": `export function handle() { return 1 }`,
    "src/c.ts": `export function handle() { return 2 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const [alpha] = nodesByName(database, PROJECT, "alpha")

    assert.equal(neighbours(database, alpha!.id).filter((e) => e.edge === "calls").length, 0)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Certification 8.5.
test("a single unimported match is linked as inferred, not extracted", async () => {
  const root = await fixture({
    "src/a.ts": `export function alpha() { return handle() }`,
    "src/b.ts": `export function handle() { return 1 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const [alpha] = nodesByName(database, PROJECT, "alpha")
    const calls = neighbours(database, alpha!.id).filter((edge) => edge.edge === "calls")

    assert.equal(calls[0]?.confidence, "inferred")
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test("impact reports what reaches a changed file", async () => {
  const root = await fixture({
    "src/a.ts": `import { beta } from "./b"\nexport function alpha() { return beta() }`,
    "src/b.ts": `export function beta() { return 2 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const reached = impactOf(database, PROJECT, ["src/b.ts"], 2).map((node) => node.name)

    assert.ok(reached.includes("alpha"), `expected alpha in ${reached.join(", ")}`)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Certification 8.4.
test("a scope bundle reports truncation instead of silently returning less", async () => {
  const many = Object.fromEntries(
    Array.from({ length: 40 }, (_value, i) => [`src/f${i}.ts`, `export function fn${i}() { return ${i} }`]),
  )
  const root = await fixture(many)
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const generous = scopeBundle(database, PROJECT, Object.keys(many), 1_000_000)
    const tight = scopeBundle(database, PROJECT, Object.keys(many), 500)

    assert.equal(generous.truncated, false)
    assert.equal(tight.truncated, true)
    assert.ok(tight.nodes.length < generous.nodes.length)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test("the graph counts nodes, edges and files it actually holds", async () => {
  const root = await fixture({
    "src/a.ts": `import { beta } from "./b"\nexport function alpha() { return beta() }`,
    "src/b.ts": `export function beta() { return 2 }`,
  })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const size = graphSize(database, PROJECT)

    assert.equal(size.files, 2)
    assert.ok(size.nodes >= 4)
    assert.ok(size.edges >= 3)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Certification 8.6. Indexing is background work; a candidate waiting on gates is not.
test("indexing yields while verification is pending and continues where it stopped", async () => {
  const root = await fixture({
    "src/a.ts": "export function alpha() { return 1 }",
    "src/b.ts": "export function beta() { return 2 }",
    "src/c.ts": "export function gamma() { return 3 }",
  })
  const database = new Database({ path: ":memory:" })
  try {
    const yielded = await indexProject(database, PROJECT, root, {
      pool,
      shouldYield: () => true,
    })

    assert.equal(yielded.yielded, true)
    assert.equal(yielded.files, 0, "nothing was persisted before the first check")

    const finished = await index(database, root)
    assert.equal(finished.yielded, false)
    assert.equal(finished.files, 3)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Certification 8.1.
test("an index that yields part way keeps what it already parsed", async () => {
  const root = await fixture({
    "src/a.ts": "export function alpha() { return 1 }",
    "src/b.ts": "export function beta() { return 2 }",
    "src/c.ts": "export function gamma() { return 3 }",
  })
  const database = new Database({ path: ":memory:" })
  try {
    // Checked once at the chunk boundary and once per file, so this yields after two files.
    let seen = 0
    const partial = await indexProject(database, PROJECT, root, {
      pool,
      shouldYield: () => (seen += 1) > 3,
    })

    assert.equal(partial.yielded, true)
    assert.equal(partial.files, 2, "the files parsed before the yield are persisted")

    const finished = await index(database, root)
    assert.equal(finished.files, 3)
    assert.equal(finished.unchanged, 2, "the persisted files are not reparsed")
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

// Phase 12 measurement found this: reading every file to notice none changed made the delta cost
// grow with the corpus rather than with the change.
test("an unchanged file is not read again once its size and mtime are recorded", async () => {
  const root = await fixture({ "src/a.ts": "export function alpha() { return 1 }" })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)
    const recorded = indexedFiles(database, PROJECT).get("src/a.ts")!
    assert.ok(recorded.size > 0, "the size was recorded")
    assert.ok(recorded.modifiedAt > 0, "the last write time was recorded")

    // The digest is deliberately corrupted: a run that reads the file would notice and reparse it.
    // A run that trusts the stat cache reports it unchanged, which is the whole point.
    database.run(
      "update index_state set digest = 'not-the-digest' where project_id = ? and path = ?",
      PROJECT,
      "src/a.ts",
    )
    const second = await index(database, root)

    assert.equal(second.unchanged, 1)
    assert.equal(second.updated, 0)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test("a file whose size or mtime moved is read, and the digest still decides", async () => {
  const root = await fixture({ "src/a.ts": "export function alpha() { return 1 }" })
  const database = new Database({ path: ":memory:" })
  try {
    await index(database, root)

    // Same bytes, new mtime: the stat cache misses, the digest matches, nothing is reparsed.
    await writeFile(join(root, "src", "a.ts"), "export function alpha() { return 1 }", "utf8")
    const touched = await index(database, root)
    assert.equal(touched.updated, 0)
    assert.equal(touched.unchanged, 1)

    // Different bytes: reparsed.
    await writeFile(join(root, "src", "a.ts"), "export function alpha() { return 2 }", "utf8")
    const edited = await index(database, root)
    assert.equal(edited.updated, 1)
  } finally {
    database.close()
    rmSync(root, { force: true, recursive: true })
  }
})
