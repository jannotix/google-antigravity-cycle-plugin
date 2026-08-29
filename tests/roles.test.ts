import assert from "node:assert/strict"
import { test } from "node:test"

import { readConfiguration } from "../src/config.ts"
import { identifyProject } from "../src/project.ts"
import { BOUNDARIES, CONSULTATION, ROLE_AGENT, resolveConsultation, resolveRole } from "../src/roles.ts"

test("every role maps to an Antigravity custom-agent name", () => {
  for (const agent of Object.values(ROLE_AGENT)) assert.match(agent, /^[a-z-]+$/u)
})

test("every consultation maps to a real role", () => {
  for (const role of Object.values(CONSULTATION)) assert.ok(role in ROLE_AGENT)
})

test("configured Antigravity tiers survive role resolution", () => {
  const config = readConfiguration({ CYCLE_OPTION_ARBITER_MODEL: "flash" })
  const role = resolveRole(config, "arbiter")
  assert.equal(role.model, "flash")
  assert.equal(role.subagentModel, "flash")
  assert.equal(role.inherits, false)
})

test("inherit is represented by omitting a model override", () => {
  const config = readConfiguration({ CYCLE_OPTION_ARCHITECT_MODEL: "inherit" })
  const role = resolveRole(config, "architect")
  assert.equal(role.model, null)
  assert.equal(role.subagentModel, null)
  assert.equal(role.inherits, true)
})

test("the executor consultation uses the read-only advisory agent", () => {
  const role = resolveConsultation(readConfiguration({}), "executor")
  assert.equal(role.agent, "executor-advisor")
})

test("read-only roles exclude every Antigravity write and delegation tool", () => {
  for (const boundary of BOUNDARIES.filter((entry) => !entry.writes)) {
    for (const tool of ["write_to_file", "replace_file_content", "run_command", "invoke_subagent"]) {
      assert.ok(boundary.cannot.includes(tool), `${boundary.role} permits ${tool}`)
    }
  }
})

test("project identity honors the Antigravity project directory", () => {
  const project = identifyProject(undefined, { ANTIGRAVITY_PROJECT_DIR: "C:/work/project" })
  const explicit = identifyProject("C:/work/project", {})
  assert.equal(project.id, explicit.id)
})
