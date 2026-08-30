import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { CURRENT_SCHEMA_VERSION } from "../src/store/migrations.ts"
import { byId, call, exchange, payload } from "./mcp-client.ts"

test("the server completes an MCP handshake and echoes the client protocol version", async () => {
  const [initialize] = await exchange([
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, protocolVersion: "2025-06-18" },
    },
  ])

  assert.equal(initialize?.result?.["protocolVersion"], "2025-06-18")
  assert.deepEqual(initialize?.result?.["capabilities"], { tools: {} })
})

test("every tool is advertised with a schema", async () => {
  const [listed] = await exchange([{ id: 1, jsonrpc: "2.0", method: "tools/list" }])

  const tools = listed?.result?.["tools"] as { inputSchema: unknown; name: string }[]
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "doctor",
      "goal",
      "graph_query",
      "index_project",
      "limits",
      "memory",
      "permissions",
      "record_event",
      "role_settings",
      "workflow",
    ],
  )
  assert.ok(tools.every((tool) => typeof tool.inputSchema === "object"))
})

test("a notification never produces a response", async () => {
  const responses = await exchange([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { id: 2, jsonrpc: "2.0", method: "ping" },
  ])

  assert.equal(responses.length, 1)
  assert.equal(responses[0]?.id, 2)
})

test("doctor returns a structured report and a rendered summary", async () => {
  const [response] = await exchange([call(1, "doctor")])

  const result = payload<{
    report: { findings: unknown[]; runtime: { node: string }; store: { schemaVersion: number } }
    summary: string
  }>(response)

  assert.equal(result.report.runtime.node, process.versions.node)
  assert.equal(result.report.store.schemaVersion, CURRENT_SCHEMA_VERSION)
  // Read, not written: the literal that used to sit here went stale across three releases while
  // the assertion kept passing.
  const manifest = JSON.parse(
    await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { version: string }
  assert.ok(result.summary.includes(`Cycle ${manifest.version}`))
  assert.ok(result.report.findings.length > 0)
})

test("a malformed database is reported by doctor instead of crashing the MCP server", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "cycle-corrupt-store-"))
  try {
    mkdirSync(dataDirectory, { recursive: true })
    writeFileSync(join(dataDirectory, "cycle.db"), "not a sqlite database")
    const [response] = await exchange([call(1, "doctor")], { dataDirectory })
    const result = payload<{
      report: { findings: { code: string; severity: string }[]; ok: boolean }
      summary: string
    }>(response)
    assert.equal(result.report.ok, false)
    assert.ok(result.report.findings.some((finding) => finding.code === "store.open" && finding.severity === "error"))
    assert.match(result.summary, /\[FAIL\].*database integrity check failed/u)
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test("an unknown tool is refused instead of answered", async () => {
  const [response] = await exchange([call(1, "does-not-exist")])

  assert.equal(response?.error?.code, -32601)
})

test("malformed input does not terminate the server", async () => {
  const responses = await exchange(["not json", { id: 7, jsonrpc: "2.0", method: "ping" }])

  // Correlated by id, not by position: the server answers each line independently.
  assert.ok(byId(responses, 7) !== undefined, "the request after the malformed line was answered")
  assert.ok(responses.some((response) => response.error !== undefined))
})
