import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { detectPackageManager, discoverGates } from "../src/evidence/discovery.ts"

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cycle-discovery-"))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content)
  }
  return root
}

const invocations = async (root: string, commands: string[] = []): Promise<string[]> =>
  (await discoverGates(root, commands)).gates.map((gate) => gate.invocation).sort()

// Certification 5.8.
test("node scripts are discovered against the fixed list, not whatever the project declares", async () => {
  const root = project({
    "package-lock.json": "{}",
    "package.json": JSON.stringify({
      scripts: { build: "tsc", deploy: "./deploy.sh", lint: "eslint .", test: "node --test" },
    }),
  })

  assert.deepEqual(await invocations(root), ["npm run build", "npm run lint", "npm run test"])
})

// Certification 5.8.
test("the package manager comes from the lockfile", async () => {
  assert.equal(await detectPackageManager(project({ "pnpm-lock.yaml": "" })), "pnpm")
  assert.equal(await detectPackageManager(project({ "yarn.lock": "" })), "yarn")
  assert.equal(await detectPackageManager(project({ "bun.lockb": "" })), "bun")
  assert.equal(await detectPackageManager(project({})), "npm")
})

// Certification 5.9.
test("a Cargo workspace gets format, clippy and test gates", async () => {
  const found = await invocations(project({ "Cargo.toml": "[package]\nname = \"x\"\n" }))

  assert.deepEqual(found, [
    "cargo clippy --all-targets --all-features -- -D warnings",
    "cargo fmt --check",
    "cargo test --all-features",
  ])
})

// Certification 5.10.
test("a Python project gets pytest, ruff and mypy", async () => {
  const found = await invocations(project({ "pyproject.toml": "[project]\nname = \"x\"\n" }))

  assert.deepEqual(found, ["mypy .", "pytest", "ruff check ."])
})

// Certification 5.11.
test("a Go module gets build, vet and test", async () => {
  const found = await invocations(project({ "go.mod": "module x\n" }))

  assert.deepEqual(found, ["go build ./...", "go test ./...", "go vet ./..."])
})

test("Makefile targets are discovered only for the known verbs", async () => {
  const root = project({ Makefile: "test:\n\techo hi\nrelease:\n\techo no\nlint:\n\techo hi\n" })

  assert.deepEqual(await invocations(root), ["make lint", "make test"])
})

// The architect wrote its command for this change; the project script was written for the project.
// Running both would run the same thing twice and record two pieces of evidence for one fact.
test("a project script identical to an architect command produces one gate", async () => {
  const root = project({
    "package-lock.json": "{}",
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })

  const report = await discoverGates(root, ["npm run test"])
  assert.equal(report.gates.length, 1)
  assert.equal(report.gates[0]?.kind, "command")
})

// Certification 5.13.
test("an unsafe architect command never becomes a gate", async () => {
  const report = await discoverGates(project({}), ["git push origin main", "bash -c ls"])

  assert.deepEqual(report.gates, [])
})
