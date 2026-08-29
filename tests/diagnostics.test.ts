import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { diagnose } from "../src/diagnostics.ts"
import { renderDoctor } from "../src/report.ts"
import { Runtime } from "../src/runtime.ts"

function environment(dataDirectory: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    CYCLE_OPTION_DATA_DIR: dataDirectory,
    ANTIGRAVITY_PROJECT_DIR: process.cwd(),
  }
}

test("doctor reports the native Antigravity provider and supported model tiers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cycle-doctor-"))
  const env = environment(directory)
  const runtime = new Runtime(env)
  try {
    const report = await diagnose(runtime, "1.1.0", env)
    assert.equal(report.models.roles.architect.provider, "antigravity")
    assert.equal(report.models.roles.architect.configured, "pro")
    assert.equal(report.models.roles.functional_reviewer.configured, "flash")
    assert.equal(report.models.credentialMode, "subscription-or-default")
    assert.match(renderDoctor(report), /antigravity/u)
  } finally {
    runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("doctor reports an unsupported provider model identifier as invalid configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cycle-doctor-invalid-"))
  const env = environment(directory, { CYCLE_OPTION_ARBITER_MODEL: "openai/gpt-5" })
  const runtime = new Runtime(env)
  try {
    const report = await diagnose(runtime, "1.1.0", env)
    assert.ok(report.findings.some((finding) => finding.code === "config.invalid" && finding.severity === "error"))
    assert.equal(report.ok, false)
  } finally {
    runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("doctor warns when both reviewers and the arbiter share one tier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cycle-doctor-correlation-"))
  const env = environment(directory, {
    CYCLE_OPTION_FUNCTIONAL_REVIEWER_MODEL: "pro",
    CYCLE_OPTION_SECURITY_REVIEWER_MODEL: "pro",
    CYCLE_OPTION_ARBITER_MODEL: "pro",
  })
  const runtime = new Runtime(env)
  try {
    const report = await diagnose(runtime, "1.1.0", env)
    assert.ok(report.findings.some((finding) => finding.code === "models.correlation"))
  } finally {
    runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
