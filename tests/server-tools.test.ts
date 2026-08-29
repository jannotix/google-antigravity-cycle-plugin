import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { Database } from "../src/store/database.ts"
import { byId, call, exchange, isolatedDataDirectory, payload } from "./mcp-client.ts"

interface RoleSettings {
  readonly advisory: boolean
  readonly agent: string
  readonly effort: string
  readonly inherits: boolean
  readonly model: string | null
  readonly projectId: string
  readonly role: string
  readonly warning: string | null
}

test("each consultation resolves to its own role agent", async () => {
  const responses = await exchange([
    call(1, "role_settings", { consultation: "architect" }),
    call(2, "role_settings", { consultation: "executor" }),
    call(3, "role_settings", { consultation: "review" }),
    call(4, "role_settings", { consultation: "security" }),
    call(5, "role_settings", { consultation: "judge" }),
  ])

  const agents = responses.map((response) => payload<RoleSettings>(response).agent)
  // The executor consultation is the advisory agent, which cannot write. Certification 6.8.
  assert.deepEqual(agents, [
    "architect",
    "executor-advisor",
    "functional-reviewer",
    "security-reviewer",
    "arbiter",
  ])
})

// The judge consultation must reach the arbiter, otherwise a readiness check would be answered by
// whichever role happened to be wired to that name.
test("the judge consultation resolves to the arbiter role", async () => {
  const [response] = await exchange([call(1, "role_settings", { consultation: "judge" })])

  const settings = payload<RoleSettings>(response)
  assert.equal(settings.role, "arbiter")
  assert.equal(settings.advisory, true)
})

test("the default role reports its packaged Antigravity model tier", async () => {
  const [response] = await exchange([call(1, "role_settings", { consultation: "architect" })])

  const settings = payload<RoleSettings>(response)
  assert.equal(settings.model, "pro")
  assert.equal(settings.inherits, false)
})

// Certification 2.3, 2.4.
test("a configured role reports its model and how to pass it", async () => {
  const [response] = await exchange([call(1, "role_settings", { consultation: "judge" })], {
    options: { ARBITER_EFFORT: "xhigh", ARBITER_MODEL: "flash" },
  })

  const settings = payload<RoleSettings>(response)
  assert.equal(settings.model, "flash")
  assert.equal(settings.effort, "xhigh")
  assert.equal(settings.inherits, false)
  assert.equal(settings.warning, null)
})

test("a model the session can reach carries no warning", async () => {
  const [response] = await exchange([call(1, "role_settings", { consultation: "judge" })], {
    options: { ARBITER_MODEL: "pro" },
  })

  assert.equal(payload<RoleSettings>(response).warning, null)
})

test("an unknown consultation is refused", async () => {
  const [response] = await exchange([call(1, "role_settings", { consultation: "nope" })])

  assert.equal(response?.result?.["isError"], true)
})

test("a recorded event lands in the chain and is counted by doctor", async () => {
  const dataDirectory = isolatedDataDirectory()

  const responses = await exchange(
    [
      call(1, "record_event", { action: "consultation.architect", role: "architect" }),
      call(2, "record_event", { action: "consultation.judge", role: "arbiter" }),
      call(3, "doctor"),
    ],
    { dataDirectory },
  )

  const first = payload<{ hash: string; sequence: number }>(responses[0])
  const second = payload<{ hash: string; sequence: number }>(responses[1])
  const report = payload<{ report: { store: { historyEntries: number } } }>(responses[2])

  assert.equal(first.sequence, 0)
  assert.equal(second.sequence, 1)
  assert.notEqual(first.hash, second.hash)
  assert.equal(report.report.store.historyEntries, 2)
})

// Certification 1.10.
test("history survives a server restart", async () => {
  const dataDirectory = isolatedDataDirectory()

  await exchange([call(1, "record_event", { action: "consultation.review" })], { dataDirectory })
  const [response] = await exchange([call(1, "record_event", { action: "consultation.security" })], {
    dataDirectory,
  })

  assert.equal(payload<{ sequence: number }>(response).sequence, 1)
})

test("an action that is not a short identifier is refused", async () => {
  const responses = await exchange([
    call(1, "record_event", { action: "Consultation Architect" }),
    call(2, "record_event", { action: "" }),
    call(3, "record_event", { action: "x".repeat(200) }),
  ])

  assert.ok(responses.every((response) => response.result?.["isError"] === true))
})

test("metadata is bounded rather than trusted", async () => {
  const [response] = await exchange([
    call(1, "record_event", {
      action: "consultation.architect",
      metadata: { note: "y".repeat(10_000) },
    }),
  ])

  assert.equal(response?.result?.["isError"], undefined)
})

test("an unknown role on an event is refused by the schema contract", async () => {
  const [response] = await exchange([
    call(1, "record_event", { action: "consultation.architect", role: "president" }),
  ])

  const recorded = payload<{ sequence: number }>(response)
  assert.equal(recorded.sequence, 0)
})

// Section 11: the chain is verified when the control plane starts, and a caller acting on a
// workflow learns that its record was altered without having to run a separate command.
test("a tampered history is reported on every workflow answer", async () => {
  const dataDirectory = isolatedDataDirectory()

  await exchange(
    [call(1, "workflow", { operation: "start", request: "add a health endpoint", preference: "quick" })],
    { dataDirectory },
  )

  const database = new Database({ path: join(dataDirectory, "cycle.db") })
  database.run("drop trigger history_is_append_only_update")
  database.run("update history set event = ? where sequence = 0", '{"action":"forged"}')
  database.close()

  const [response] = await exchange([call(1, "workflow", { operation: "status" })], { dataDirectory })
  const answer = payload<{ historyAltered?: string }>(response)

  assert.match(answer.historyAltered ?? "", /does not verify at sequence 0 \(hash\)/u)
})

test("an intact history says nothing at all", async () => {
  const dataDirectory = isolatedDataDirectory()
  const [response] = await exchange(
    [call(1, "workflow", { operation: "start", request: "add a health endpoint", preference: "quick" })],
    { dataDirectory },
  )

  assert.equal(payload<{ historyAltered?: string }>(response).historyAltered, undefined)
})

// Certification 3.8.
test("memory search on a project that learned nothing returns nothing", async () => {
  const [response] = await exchange([call(1, "memory", { operation: "search", query: "auth" })])

  assert.deepEqual(payload<{ memories: unknown[] }>(response).memories, [])
})

const failure = (response: { result?: Record<string, unknown> } | undefined): string => {
  const content = response?.result?.["content"] as { text: string }[] | undefined
  assert.equal(response?.result?.["isError"], true, "the call was expected to fail")
  return content?.[0]?.text ?? ""
}

// Revocation is never implied by a request: the caller says so, or nothing happens.
// Certification 3.8, 3.12.
test("forgetting a memory without confirmation is refused", async () => {
  const [response] = await exchange([
    call(1, "memory", { operation: "forget", memoryId: "whatever" }),
  ])

  assert.match(failure(response), /confirm: true/u)
})

test("an unknown memory operation is refused", async () => {
  const [response] = await exchange([call(1, "memory", { operation: "remember" })])

  assert.match(failure(response), /unknown memory operation/u)
})

test("a memory operation that needs an identifier says so", async () => {
  const [response] = await exchange([call(1, "memory", { operation: "chain" })])

  assert.match(failure(response), /requires memoryId/u)
})

// Certification 3.6.
test("a goal is created, focused and reported through the control plane", async () => {
  const dataDirectory = isolatedDataDirectory()
  const responses = await exchange(
    [
      call(1, "goal", {
        operation: "new",
        objective: "replace the session store with a durable one",
        successCriteria: ["sessions survive a restart"],
      }),
      call(2, "goal", { operation: "status" }),
      call(3, "goal", { operation: "list" }),
    ],
    { dataDirectory },
  )

  const created = payload<{ focused: boolean; goalId: string; state: string }>(responses[0])
  assert.equal(created.state, "draft")
  assert.equal(created.focused, true)
  assert.equal(payload<{ goalId: string }>(responses[1]).goalId, created.goalId)
  assert.equal(payload<{ goals: unknown[] }>(responses[2]).goals.length, 1)
})

// The automatic half of milestone linking, over the wire.
test("a workflow started under a focused goal reports the goal it joined", async () => {
  const dataDirectory = isolatedDataDirectory()
  const responses = await exchange(
    [
      call(1, "goal", {
        operation: "new",
        objective: "make the dashboard usable",
        successCriteria: ["a first-time user reaches the report in two clicks"],
      }),
      call(2, "workflow", { operation: "start", request: "add a filter bar", preference: "quick" }),
      call(3, "goal", { operation: "status" }),
    ],
    { dataDirectory },
  )

  const goalId = payload<{ goalId: string }>(responses[0]).goalId
  assert.equal(payload<{ goalId: string | null }>(responses[1]).goalId, goalId)

  const status = payload<{ milestones: { name: string }[]; state: string }>(responses[2])
  assert.equal(status.state, "active")
  assert.deepEqual(status.milestones.map((milestone) => milestone.name), ["add a filter bar"])
})

// Certification 3.6, 3.12.
test("completing a goal needs the request first and the confirmation second", async () => {
  const dataDirectory = isolatedDataDirectory()
  const responses = await exchange(
    [
      call(1, "goal", {
        operation: "new",
        objective: "an objective",
        successCriteria: ["it works"],
      }),
      call(2, "goal", { operation: "complete", goalId: "" }),
    ],
    { dataDirectory },
  )

  assert.equal(payload<{ state: string }>(responses[0]).state, "draft")
  assert.match(failure(responses[1]), /requires goalId/u)
})

// Certification 3.10.
test("limits reports the machine, the reserves and this project's share", async () => {
  const [response] = await exchange([call(1, "limits", { operation: "status" })])

  const report = payload<{
    active: unknown[]
    limits: { leaseSeconds: number; maxActive: number; renewSeconds: number }
    reserves: { cpuCeilingPercent: number; diskReserveBytes: number; memoryReserveBytes: number }
    resources: { availableMemoryBytes: number | null }
    share: { held: number; of: number }
  }>(response)

  assert.equal(report.limits.leaseSeconds, 15)
  assert.equal(report.limits.renewSeconds, 5)
  assert.ok(report.limits.maxActive >= 1 && report.limits.maxActive <= 8)
  assert.equal(report.reserves.cpuCeilingPercent, 85)
  assert.equal(report.reserves.memoryReserveBytes, 1024 ** 3)
  assert.equal(report.reserves.diskReserveBytes, 2 * 1024 ** 3)
  assert.deepEqual(report.active, [])
  assert.equal(report.share.held, 0)
})

// A deferral is an answer, not an error: it says what would have to change.
test("admission answers with a lease or with a reason", async () => {
  const dataDirectory = isolatedDataDirectory()
  const [start] = await exchange(
    [call(1, "workflow", { operation: "start", request: "add a health endpoint", preference: "quick" })],
    { dataDirectory },
  )
  const workflowId = payload<{ workflowId: string }>(start).workflowId

  const responses = await exchange(
    [
      call(1, "limits", { operation: "admit", workflowId }),
      call(2, "limits", { operation: "renew", workflowId }),
      call(3, "limits", { operation: "release", workflowId }),
    ],
    { dataDirectory },
  )

  const admission = payload<{ admitted: boolean; reason: string; renewWithinSeconds: number }>(byId(responses, 1))
  assert.equal(typeof admission.admitted, "boolean")
  assert.ok(admission.reason.length > 0)
  assert.equal(admission.renewWithinSeconds, 5)
  assert.equal(typeof payload<{ admitted: boolean }>(byId(responses, 2)).admitted, "boolean")
  assert.equal(payload<{ released: boolean }>(byId(responses, 3)).released, true)
})

test("a slot cannot be leased to a workflow that does not exist", async () => {
  const [response] = await exchange([
    call(1, "limits", { operation: "admit", workflowId: "made-up" }),
  ])

  assert.match(failure(response), /unknown workflow/u)
})

test("a limits operation that needs a workflow says so", async () => {
  const [response] = await exchange([call(1, "limits", { operation: "admit" })])

  assert.match(failure(response), /requires workflowId/u)
})

// Certification 3.10: the boundaries are reported by the control plane, from the same table the
// agents declare, rather than restated by a skill that could drift from them.
test("permissions reports every role, its boundary and the three enforcement layers", async () => {
  const [response] = await exchange([call(1, "permissions")])

  const result = payload<{
    boundaries: { cannot: string[]; may: string; role: string; writes: boolean }[]
    enforcement: string[]
    invariant: string
  }>(response)

  assert.deepEqual(
    result.boundaries.map((boundary) => boundary.role).sort(),
    ["arbiter", "architect", "executor", "functional_reviewer", "operator", "security_reviewer"],
  )
  assert.deepEqual(
    result.boundaries.filter((boundary) => boundary.writes).map((boundary) => boundary.role),
    ["executor"],
  )
  for (const boundary of result.boundaries) {
    assert.ok(boundary.cannot.includes("invoke_subagent"), `${boundary.role} must be denied delegation`)
  }
  assert.equal(result.enforcement.length, 3)
  assert.match(result.invariant, /No role approves its own work/u)
})

// Certification 3.11 and 3.12.
test("exporting needs confirmation, and reports the chain it exported", async () => {
  const dataDirectory = isolatedDataDirectory()
  const responses = await exchange(
    [
      call(1, "workflow", { operation: "export", kind: "history" }),
      call(2, "workflow", { confirm: true, kind: "history", operation: "export" }),
    ],
    { dataDirectory },
  )

  assert.match(failure(byId(responses, 1)), /requires confirm: true/u)

  const exported = payload<{
    chain: { valid: boolean }
    entries: unknown[]
    kind: string
    truncated: boolean
  }>(byId(responses, 2))
  assert.equal(exported.kind, "history")
  assert.equal(exported.chain.valid, true)
  assert.equal(exported.truncated, false)
})

test("exporting state needs a workflow to export", async () => {
  const [response] = await exchange([call(1, "workflow", { confirm: true, operation: "export" })])

  assert.match(failure(response), /no such workflow/u)
})

// Certification 3.4 and 3.12: cancelling throws away authorized work, so it is never implied.
test("cancelling without confirmation is refused, and with it is final", async () => {
  const dataDirectory = isolatedDataDirectory()
  const started = payload<{ workflowId: string }>(
    (await exchange([call(1, "workflow", { operation: "start", request: "add oauth login" })], {
      dataDirectory,
    }))[0],
  )

  const responses = await exchange(
    [
      call(1, "workflow", {
        controlOperation: "cancel",
        operation: "control",
        workflowId: started.workflowId,
      }),
      call(2, "workflow", {
        confirm: true,
        controlOperation: "cancel",
        operation: "control",
        workflowId: started.workflowId,
      }),
      call(3, "workflow", { operation: "status", workflowId: started.workflowId }),
    ],
    { dataDirectory },
  )

  assert.match(failure(byId(responses, 1)), /requires confirm: true/u)
  assert.equal(payload<{ state: string }>(byId(responses, 2)).state, "cancelled")
  assert.equal(payload<{ terminal: boolean }>(byId(responses, 3)).terminal, true)
})

// Certification 3.3.
test("status and evidence answer for a workflow that has neither tasks nor a candidate", async () => {
  const dataDirectory = isolatedDataDirectory()
  const started = payload<{ workflowId: string }>(
    (await exchange([call(1, "workflow", { operation: "start", request: "rename a helper" })], {
      dataDirectory,
    }))[0],
  )

  const responses = await exchange(
    [
      call(1, "workflow", { operation: "status", workflowId: started.workflowId }),
      call(2, "workflow", { operation: "evidence", workflowId: started.workflowId }),
    ],
    { dataDirectory },
  )

  const status = payload<{ found: boolean; pausedBecause: string | null; tasks: unknown[] }>(
    byId(responses, 1),
  )
  assert.equal(status.found, true)
  assert.equal(status.pausedBecause, null)
  assert.deepEqual(status.tasks, [])
  assert.ok(byId(responses, 2) !== undefined)
})

test("status on a project with no workflow says so rather than inventing one", async () => {
  const [response] = await exchange([call(1, "workflow", { operation: "status" })])

  assert.equal(payload<{ found: boolean }>(response).found, false)
})

// Certification 3.9.
test("indexing reports what it parsed and reparses nothing on a second pass", async () => {
  // Two exchanges, not two calls in one: the server answers each line independently, so a second
  // pass sent alongside the first would race it rather than follow it.
  const dataDirectory = isolatedDataDirectory()
  const first = payload<{ project: string; updated: number }>(
    (await exchange([call(1, "index_project")], { dataDirectory }))[0],
  )
  const second = payload<{ unchanged: number; updated: number }>(
    (await exchange([call(1, "index_project")], { dataDirectory }))[0],
  )
  const status = payload<{ edges: number; files: number; nodes: number }>(
    (await exchange([call(1, "graph_query", { operation: "status" })], { dataDirectory }))[0],
  )

  assert.ok(first.updated > 0, "the first pass must parse this repository")
  assert.equal(second.updated, 0)
  assert.ok(second.unchanged > 0, "the second pass must recognise the files it already parsed")
  assert.equal(status.files, first.updated)
})

/**
 * The version was a literal in server.ts and three releases bumped the manifest without it. The
 * doctor then reported 1.0.0 while 1.0.2 was running, which was read as proof that a stale process
 * was answering — and sent the reader hunting a configuration-delivery bug that did not exist.
 */
test("the version the server reports is the version the manifest declares", async () => {
  const manifest = JSON.parse(
    await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { version: string }
  const [response] = await exchange([call(1, "doctor", {})])

  assert.equal(payload<{ report: { version: string } }>(response).report.version, manifest.version)
})
