import assert from "node:assert/strict"
import { test } from "node:test"

import { readConfiguration } from "../src/config.ts"
import { describeProviders } from "../src/providers.ts"

test("every role runs through the native Antigravity provider boundary", () => {
  const described = describeProviders(readConfiguration({}))
  assert.equal(described.distinctProviders, 1)
  assert.equal(described.gateway, false)
  assert.equal(described.credentialVariable, null)
  assert.deepEqual(described.unroutable, [])
  for (const role of Object.values(described.roles)) {
    assert.equal(role.provider, "antigravity")
    assert.equal(role.billing, "subscription")
  }
})

test("configured tiers are reported without inventing external provider support", () => {
  const described = describeProviders(readConfiguration({ CYCLE_OPTION_ARCHITECT_MODEL: "flash" }))
  assert.equal(described.roles.architect.configured, "flash")
  assert.equal(described.roles.architect.resolved, "flash tier")
  assert.equal(described.roles.architect.provider, "antigravity")
})
