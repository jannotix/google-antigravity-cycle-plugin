import assert from "node:assert/strict"
import { test } from "node:test"

import { probeVersion, resolveExecutable } from "../src/exec.ts"

test("a real executable on PATH is resolved", async () => {
  const resolved = await resolveExecutable("git")

  assert.notEqual(resolved, null)
  assert.equal(resolved?.kind, "binary")
})

test("a name that is not on PATH resolves to null", async () => {
  assert.equal(await resolveExecutable("cycle-nonexistent-program"), null)
})

// Windows script runners are .cmd shims. Node refuses to spawn them without a shell, so the
// resolver must report them as present rather than reporting them missing.
// Certification 5.14.
test("a Windows shim is resolved and classified, never reported missing", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only")

  const resolved = await resolveExecutable("npm")

  assert.notEqual(resolved, null, "npm must be detected even though it is a .cmd shim")
  assert.equal(resolved?.kind, "shim")
})

test("PATHEXT drives resolution order on Windows", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only")

  const resolved = await resolveExecutable("node", { ...process.env, PATHEXT: ".EXE" })

  assert.match(resolved?.path ?? "", /node\.exe$/iu)
})

// Certification 5.14.
test("a shim is never executed to obtain a version", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only")

  const probe = await probeVersion("npm", ["--version"], 4_000)

  assert.equal(probe?.resolved.kind, "shim")
  assert.equal(probe?.version, null)
})

test("a binary reports its version", async () => {
  const probe = await probeVersion("git", ["--version"], 4_000)

  assert.match(probe?.version ?? "", /^git version/u)
})
