import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

// @ts-expect-error the packaging scripts are plain JavaScript, deliberately dependency-free
import { collect, FORBIDDEN, readEntries, ROOT, runtimePackage, violations } from "../scripts/manifest.mjs"
// @ts-expect-error the packaging scripts are plain JavaScript, deliberately dependency-free
import { createZip } from "../scripts/zip.mjs"

const artifact: Promise<string[]> = collect() as Promise<string[]>

// Certification 13.1.
test("the artifact carries no tests, fixtures or debug output", async () => {
  const paths = await artifact

  assert.equal(violations(paths).length, 0, JSON.stringify(violations(paths)))
  assert.equal(paths.some((path) => path.startsWith("tests/")), false)
  assert.ok(paths.some((path) => path.startsWith("docs/")), "user documentation must ship")
  assert.equal(paths.some((path) => path.includes("fixture")), false)
})

// Certification 13.2.
test("the artifact carries no source maps, sources or development configuration", async () => {
  const paths = await artifact

  assert.equal(paths.some((path) => path.endsWith(".map")), false)
  assert.equal(paths.some((path) => path.endsWith(".ts")), false)
  assert.equal(paths.some((path) => path.startsWith("src/")), false)
  assert.equal(paths.some((path) => /tsconfig/u.test(path)), false)
  assert.equal(paths.some((path) => path.includes("node_modules")), false)
  assert.equal(paths.some((path) => path.endsWith("package-lock.json")), false)
})

// Certification 13.3. The check runs on the built file list, not on the rules that produced it, so
// a mistake in the allowlist fails the build rather than reaching a user.
test("an excluded file that reaches the artifact fails the build", () => {
  for (const [path, reason] of [
    ["tests/store.test.js", "test file"],
    ["dist/server.js.map", "source map"],
    ["tsconfig.json", "development configuration"],
    ["node_modules/x/index.js", "dependency tree"],
    [".env", "credential"],
    ["tests-debug/scratch.json", "debug output"],
  ]) {
    const found = violations([path!]) as { reason: string }[]
    assert.ok(found.length > 0, `${path} should be refused`)
    assert.equal(found[0]?.reason, reason)
  }
})

test("every forbidden rule is reachable, so none is dead", () => {
  const samples = [
    "src/a.ts",
    "dist/a.d.ts",
    "dist/a.js.map",
    "tests/a.test.js",
    "fixtures/a.json",
    "coverage/a.json",
    "tests-debug/a.log",
    "tsconfig.tests.json",
    "package-lock.json",
    "node_modules/a/b.js",
    "dist/.tsbuildinfo",
    ".gitignore",
    "auth.json",
    "scripts/package.mjs",
  ]
  const reasons = new Set(
    samples.flatMap((path) => (violations([path]) as { reason: string }[]).map((v) => v.reason)),
  )

  assert.equal(reasons.size, (FORBIDDEN as unknown[]).length)
})

test("the artifact carries what the plugin needs to start", async () => {
  const paths = await artifact

  for (const required of [
    "plugin.json",
    "mcp_config.json",
    "hooks.json",
    "dist/server.js",
    "LICENSE",
    "NOTICE",
    "README.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "hooks/guard.mjs",
    "docs/manual.md",
  ]) {
    assert.ok(paths.includes(required), `missing ${required}`)
  }

  assert.ok(paths.filter((path) => path.startsWith("agents/")).length >= 6)
  assert.ok(paths.filter((path) => path.startsWith("skills/")).length >= 20)
  assert.ok(paths.filter((path) => path.endsWith(".wasm")).length >= 12)
})

// dist/*.js is ESM. Without this file Node reads it as CommonJS and the server fails to start.
test("the artifact declares itself an ES module and ships no build tooling", async () => {
  const source = JSON.parse(await readFile(join(ROOT as string, "package.json"), "utf8"))
  const runtime = JSON.parse(runtimePackage(source) as string)

  assert.equal(runtime.type, "module")
  assert.equal(runtime.version, source.version)
  assert.equal(runtime.scripts, undefined)
  assert.equal(runtime.devDependencies, undefined)
  assert.equal(runtime.dependencies, undefined)
})

test("packaging canonicalises text line endings across Windows and Linux", async () => {
  const work = mkdtempSync(join(tmpdir(), "cycle-lines-"))
  try {
    writeFileSync(join(work, "NOTICE"), "one\r\ntwo\r")
    writeFileSync(join(work, "binary.wasm"), Buffer.from([0, 13, 10, 255]))
    const entries = await readEntries(["NOTICE", "binary.wasm"], work)
    assert.equal(entries.find((entry: { path: string }) => entry.path === "NOTICE")?.data.toString(), "one\ntwo\n")
    assert.deepEqual(entries.find((entry: { path: string }) => entry.path === "binary.wasm")?.data, Buffer.from([0, 13, 10, 255]))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test("the plugin manifest contains only fields accepted by the Antigravity schema", async () => {
  const manifest = JSON.parse(
    await readFile(join(ROOT as string, "plugin.json"), "utf8"),
  )
  assert.deepEqual(Object.keys(manifest).sort(), ["description", "name"])
  assert.equal(manifest.name, "cycle")
})

/**
 * A zip only this writer can read would be worse than no zip at all, so the archive is opened by
 * libarchive rather than by anything in this repository. GNU tar cannot read zip; bsdtar can, and
 * ships in System32 on Windows.
 */
test("the archive is readable by a tool that did not write it", async (t) => {
  const reader = bsdtar()
  if (reader === null) return t.skip("bsdtar (libarchive) is not available on this machine")

  const paths = (await artifact).slice(0, 40)
  const entries = await readEntries(paths)
  const archive = createZip(entries) as Buffer

  const work = mkdtempSync(join(tmpdir(), "cycle-zip-"))
  try {
    const zipPath = join(work, "a.zip")
    const out = join(work, "out")
    writeFileSync(zipPath, archive)
    mkdirSync(out, { recursive: true })
    execFileSync(reader, ["-xf", zipPath, "-C", out], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    })

    const listed = execFileSync(reader, ["-tf", zipPath], { encoding: "utf8", timeout: 60_000 })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    assert.deepEqual(listed.sort(), [...paths].sort())

    for (const path of paths) {
      const extracted = await readFile(join(out, path))
      const original = entries.find((entry: { path: string }) => entry.path === path)
      assert.deepEqual(extracted, original.data, path)
    }
  } finally {
    rmSync(work, { force: true, recursive: true })
  }
})

function bsdtar(): string | null {
  const candidates =
    process.platform === "win32"
      ? [join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")]
      : ["/usr/bin/bsdtar", "/usr/local/bin/bsdtar", "bsdtar"]

  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      })
      if (version.includes("bsdtar") || version.includes("libarchive")) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

// The reversed polynomial was wrong once, and lenient readers accepted the result. A known answer
// catches that without needing an external tool.
test("the archive checksum matches the CRC-32 known answer", () => {
  const archive = createZip([{ data: Buffer.from("123456789"), path: "a" }]) as Buffer

  assert.equal(archive.readUInt32LE(14), 0xcb_f4_39_26)
})

test("an empty file and a file that deflates larger both round trip", async () => {
  const work = mkdtempSync(join(tmpdir(), "cycle-zip-edge-"))
  try {
    await mkdir(dirname(join(work, "a/b.txt")), { recursive: true })
    const entries = [
      { data: Buffer.alloc(0), path: "empty.txt" },
      { data: Buffer.from("x"), path: "tiny.txt" },
      { data: Buffer.from("a".repeat(100_000)), path: "a/b.txt" },
    ]
    const archive = createZip(entries) as Buffer

    assert.equal(archive.subarray(0, 2).toString(), "PK")
    assert.ok(archive.length > 0)
    assert.ok(archive.includes(Buffer.from("empty.txt")))
  } finally {
    rmSync(work, { force: true, recursive: true })
  }
})

/**
 * The workflow script is the product's main command and nothing else in this suite loads it: a
 * syntax error in it passed 434 green tests and would have shipped. It is not a module — the
 * runtime wraps it, so it uses top-level `return` and `await` — which is why it is compiled inside
 * an async wrapper here rather than imported.
 */
test("the governed run skill uses Antigravity-native delegation and the Cycle control plane", async () => {
  const source = await readFile(join(ROOT as string, "skills", "run", "SKILL.md"), "utf8")
  assert.match(source, /invoke_subagent/u)
  assert.match(source, /subagents are asynchronous/u)
  assert.match(source, /manage_subagents/u)
  assert.match(source, /cycle-control\/workflow/u)
  assert.doesNotMatch(source, /Agent tool|subagent_type|mcp__plugin_cycle_control/u)
})

test("every background role persists its own governed result", async () => {
  const agents = join(ROOT as string, "agents")
  const architect = await readFile(join(agents, "architect.md"), "utf8")
  const executor = await readFile(join(agents, "executor.md"), "utf8")
  const functional = await readFile(join(agents, "functional-reviewer.md"), "utf8")
  const security = await readFile(join(agents, "security-reviewer.md"), "utf8")
  const arbiter = await readFile(join(agents, "arbiter.md"), "utf8")

  assert.match(architect, /operation: "submit_plan"/u)
  assert.match(executor, /report_task/u)
  assert.match(executor, /freeze_candidate/u)
  assert.match(executor, /call `verify`/u)
  assert.match(executor, /Never fall back to `run_command`/u)
  assert.match(executor, /authorized shared project/u)
  assert.match(functional, /role: "functional_reviewer"/u)
  assert.match(security, /role: "security_reviewer"/u)
  assert.match(arbiter, /operation: "arbitrate"/u)
  assert.match(arbiter, /do not inspect\s+your workspace/u)
  for (const source of [architect, executor, functional, security, arbiter]) {
    assert.match(source, /Antigravity executes .*background|Antigravity runs subagents asynchronously/su)
    assert.match(source, /workflowId/u)
  }
})

/**
 * The graph was built, exposed as a tool, documented in the README — and never mentioned to the
 * roles, so every one of them read files it could have asked about. Nothing failed; the capability
 * was simply unreachable from inside the cycle.
 */
test("the run skill tells planning, execution and review roles how to use the code graph", async () => {
  const source = await readFile(join(ROOT as string, "skills", "run", "SKILL.md"), "utf8")
  assert.match(source, /graph_query/u)
  assert.match(source, /architect/u)
  assert.match(source, /executor/u)
  assert.match(source, /functional-reviewer/u)
})

/**
 * Nothing in the plugin named the user's language, so every role answered in the language of its
 * own prompt — English — whatever the user wrote in. The contract must not follow: a translated
 * decision, status or identifier is refused by the control plane.
 */
test("the run skill preserves the user's language and structured contract values", async () => {
  const source = await readFile(join(ROOT as string, "skills", "run", "SKILL.md"), "utf8")
  assert.match(source, /language of the immutable original request/u)
  assert.match(source, /Do not translate the\s+structured values/u)
})
