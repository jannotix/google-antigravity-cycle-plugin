import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { outputDigest } from "../src/evidence/digest.ts"
import { MAX_OUTPUT_BYTES, resolveRunnable, runCommand } from "../src/evidence/runner.ts"
import { parseCommand } from "../src/workflow/commands.ts"

const CWD = process.cwd()

function scriptDirectory(source: string): { file: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "cycle-runner-"))
  const file = join(root, "script.mjs")
  writeFileSync(file, source)
  return { file, root }
}

test("a project command runs and its exit code decides the gate", async () => {
  const outcome = await runCommand(parseCommand("node --version"), {
    cwd: CWD,
    timeoutSeconds: 60,
  })

  assert.equal(outcome.unavailable, null)
  assert.equal(outcome.exitCode, 0)
  assert.match(outcome.output, /^v\d+\./u)
})

test("a non-zero exit is reported, not swallowed", async () => {
  const { file, root } = scriptDirectory("process.exit(3)\n")
  const outcome = await runCommand(parseCommand(`node ${file}`), { cwd: root, timeoutSeconds: 60 })

  assert.equal(outcome.exitCode, 3)
})

test("a program that is not installed is unavailable, never passed", async () => {
  const outcome = await runCommand(parseCommand("definitely-not-a-real-program --version"), {
    cwd: CWD,
    timeoutSeconds: 60,
  })

  assert.match(outcome.unavailable ?? "", /was not found on PATH/u)
  assert.equal(outcome.exitCode, null)
})

// The rules were applied when the plan was validated. They are applied again here because the plan
// is not the only path into the runner.
// Certification 5.13.
test("a blocked program is refused at execution as well as at planning", async () => {
  const outcome = await runCommand({ arguments: ["status"], program: "git" }, {
    cwd: CWD,
    timeoutSeconds: 60,
  })

  assert.match(outcome.unavailable ?? "", /gates run without a shell/u)
})

// Certification 5.16.
test("output beyond the cap is truncated and the digest still covers all of it", async () => {
  const line = "x".repeat(1_000)
  const { file, root } = scriptDirectory(
    `const line = ${JSON.stringify(line)}\nfor (let i = 0; i < 2000; i += 1) process.stdout.write(line)\n`,
  )
  const outcome = await runCommand(parseCommand(`node ${file}`), { cwd: root, timeoutSeconds: 120 })

  assert.equal(Buffer.byteLength(outcome.output), MAX_OUTPUT_BYTES)
  assert.equal(outcome.outputDigest, outputDigest(line.repeat(2_000)))
})

// Certification 5.15.
test("a gate that exceeds its timeout is terminated and recorded as failing", async () => {
  const { file, root } = scriptDirectory("setTimeout(() => {}, 60_000)\n")
  const outcome = await runCommand(parseCommand(`node ${file}`), { cwd: root, timeoutSeconds: 1 })

  assert.equal(outcome.timedOut, true)
  assert.notEqual(outcome.exitCode, 0)
})

test("the output digest is domain separated, so it cannot be replayed as another digest", () => {
  assert.notEqual(outputDigest("hello"), createHash("sha256").update("hello").digest("hex"))
})

/**
 * The obstacle recorded as D-012: npm is a .cmd shim on Windows and cannot be spawned without a
 * shell. Resolution must produce this process's own Node plus npm's real entry point.
 */
test(
  "a Windows script runner resolves to its real entry point instead of its shim",
  { skip: process.platform !== "win32" },
  async () => {
    const runnable = await resolveRunnable("npm")

    assert.ok(!("unavailable" in runnable), `npm did not resolve: ${JSON.stringify(runnable)}`)
    if ("unavailable" in runnable) return
    assert.equal(runnable.file, process.execPath)
    assert.match(runnable.arguments[0] ?? "", /npm-cli\.js$/u)
  },
)

test(
  "a resolved script runner actually executes without a shell",
  { skip: process.platform !== "win32" },
  async () => {
    const outcome = await runCommand(parseCommand("npm --version"), {
      cwd: CWD,
      timeoutSeconds: 120,
    })

    assert.equal(outcome.unavailable, null)
    assert.equal(outcome.exitCode, 0)
    assert.match(outcome.output.trim(), /^\d+\.\d+\.\d+/u)
  },
)

// Certification 5.14.
test("an unknown shim is reported, never shelled out to", async () => {
  const runnable = await resolveRunnable("whatever", { PATH: "" }, "win32")

  assert.ok("unavailable" in runnable)
})
