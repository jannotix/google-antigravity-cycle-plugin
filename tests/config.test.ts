import assert from "node:assert/strict"
import { test } from "node:test"

import { readConfiguration } from "../src/config.ts"

test("an unconfigured Antigravity install uses only supported model tiers", () => {
  const config = readConfiguration({})
  assert.equal(config.roles.architect.model, "pro")
  assert.equal(config.roles.functional_reviewer.model, "flash")
  assert.equal(config.roles.operator.model, "flash")
  assert.equal(config.invalid.length, 0)
})

test("Antigravity model tiers and efforts can be configured explicitly", () => {
  const config = readConfiguration({
    CYCLE_OPTION_ARCHITECT_MODEL: "inherit",
    CYCLE_OPTION_ARCHITECT_EFFORT: "xhigh",
    CYCLE_OPTION_REVIEWER_EFFORT: "medium",
  })
  assert.equal(config.roles.architect.model, "inherit")
  assert.equal(config.roles.architect.effort, "xhigh")
  assert.equal(config.roles.functional_reviewer.effort, "medium")
  assert.equal(config.roles.security_reviewer.effort, "medium")
  assert.equal(config.delivered, 3)
})

test("provider model identifiers are rejected instead of silently pretending Antigravity supports them", () => {
  const config = readConfiguration({ CYCLE_OPTION_ARBITER_MODEL: "openai/gpt-5" })
  assert.equal(config.roles.arbiter.model, "pro")
  assert.match(config.invalid.join("\n"), /model tiers/u)
})

test("blank options are not counted as delivered", () => {
  const config = readConfiguration({ CYCLE_OPTION_EXECUTOR_MODEL: "" })
  assert.equal(config.delivered, 0)
  assert.equal(config.blank, 1)
})

test("repair cycles and security proofs fail closed on invalid values", () => {
  const config = readConfiguration({
    CYCLE_OPTION_MAX_REPAIR_CYCLES: "0",
    CYCLE_OPTION_SECURITY_PROOFS: "maybe",
  })
  assert.equal(config.maxRepairCycles, 5)
  assert.equal(config.securityProofs, false)
  assert.equal(config.invalid.length, 2)
})

test("unknown Cycle options are reported", () => {
  const config = readConfiguration({ CYCLE_OPTION_NOT_REAL: "yes" })
  assert.deepEqual(config.unknown, ["NOT_REAL"])
})
