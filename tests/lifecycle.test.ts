import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const SCRIPT = join(process.cwd(), "bin", "cycle-lifecycle.mjs")

test("install, upgrade, uninstall and rollback preserve recoverable copies", () => {
  const root = mkdtempSync(join(tmpdir(), "cycle-lifecycle-"))
  const config = join(root, "config")
  const first = plugin(join(root, "first"), "first")
  const second = plugin(join(root, "second"), "second")
  try {
    const installed = run("install", first, config)
    assert.equal(installed["installed"], true)
    assert.equal(readFileSync(join(config, "plugins", "cycle", "dist", "server.js"), "utf8"), "first")

    const upgraded = run("upgrade", second, config)
    assert.ok(upgraded["backup"])
    assert.equal(readFileSync(join(config, "plugins", "cycle", "dist", "server.js"), "utf8"), "second")

    const uninstalled = run("uninstall", undefined, config)
    assert.equal(uninstalled["installed"], false)

    const rolledBack = invoke(["rollback", "--config-root", config, "--backup", upgraded["backup"] as string])
    assert.equal(rolledBack["installed"], true)
    assert.equal(readFileSync(join(config, "plugins", "cycle", "dist", "server.js"), "utf8"), "first")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an incomplete plugin is refused before the installed copy changes", () => {
  const root = mkdtempSync(join(tmpdir(), "cycle-lifecycle-refuse-"))
  const config = join(root, "config")
  const valid = plugin(join(root, "valid"), "valid")
  const invalid = join(root, "invalid")
  mkdirSync(invalid, { recursive: true })
  try {
    run("install", valid, config)
    const child = spawnSync(process.execPath, [SCRIPT, "upgrade", "--source", invalid, "--config-root", config], { encoding: "utf8" })
    assert.notEqual(child.status, 0)
    assert.equal(readFileSync(join(config, "plugins", "cycle", "dist", "server.js"), "utf8"), "valid")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function plugin(path: string, server: string): string {
  mkdirSync(join(path, "dist"), { recursive: true })
  writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: "cycle", description: "test" }))
  writeFileSync(join(path, "mcp_config.json"), JSON.stringify({ mcpServers: {} }))
  writeFileSync(join(path, "hooks.json"), JSON.stringify({}))
  writeFileSync(join(path, "dist", "server.js"), server)
  return path
}

function run(action: string, source: string | undefined, config: string): Record<string, unknown> {
  const args = [action]
  if (source !== undefined) args.push("--source", source)
  args.push("--config-root", config)
  return invoke(args)
}

function invoke(args: string[]): Record<string, unknown> {
  const child = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout) as Record<string, unknown>
}
