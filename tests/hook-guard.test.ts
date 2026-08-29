import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { test } from "node:test"

// @ts-expect-error the production hook is plain dependency-free JavaScript
import { decide } from "../hooks/guard.mjs"

const command = (CommandLine: string) => ({ toolCall: { name: "run_command", args: { CommandLine } } })

test("ordinary commands are allowed", () => {
  assert.deepEqual(decide(command("npm test")), { decision: "allow" })
  assert.deepEqual(decide({ toolCall: { name: "view_file", args: {} } }), { decision: "allow" })
})

test("history-changing, publication and recursive deletion commands require explicit approval", () => {
  for (const value of ["git push origin main", "git commit -m release", "npm publish", "gh release create v1", "Remove-Item x -Recurse -Force"]) {
    const result = decide(command(value))
    assert.equal(result.decision, "force_ask", value)
    assert.match(result.reason ?? "", /explicit user approval/u)
  }
})

test("the hook speaks the Antigravity stdin and stdout contract", () => {
  const path = join(process.cwd(), "hooks", "guard.mjs")
  const child = spawnSync(process.execPath, [path], {
    input: JSON.stringify(command("git push origin main")),
    encoding: "utf8",
    timeout: 10_000,
  })
  assert.equal(child.status, 0)
  assert.equal(JSON.parse(child.stdout).decision, "force_ask")
})

test("a malformed payload asks instead of silently allowing", () => {
  const path = join(process.cwd(), "hooks", "guard.mjs")
  const child = spawnSync(process.execPath, [path], { input: "{", encoding: "utf8", timeout: 10_000 })
  assert.equal(JSON.parse(child.stdout).decision, "ask")
})
