import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

test("release receipts do not make the exact-SHA checkout dirty", async () => {
  const workflow = await readFile(join(process.cwd(), ".github", "workflows", "release-candidate.yml"), "utf8")
  assert.doesNotMatch(workflow, /tee status\.txt/u)
  assert.match(workflow, /status="\$\(git status --porcelain\)"/u)
  assert.match(workflow, /certification-artifacts\/exact-sha\.txt/u)
})

test("the capacity-heavy 500k lane is explicit and resource-admitted on an isolated runner", async () => {
  const workflow = await readFile(join(process.cwd(), ".github", "workflows", "release-candidate.yml"), "utf8")
  assert.match(workflow, /run_500k:/u)
  assert.match(workflow, /if: \$\{\{ inputs\.run_500k \}\}/u)
  assert.match(workflow, /runs-on: ubuntu-latest/u)
  assert.match(workflow, /minimum-free-memory-gib 6/u)
  assert.match(workflow, /timeout-minutes: 120/u)
})

test("the Linux Antigravity installer uses the script's supported isolated directory flag", async () => {
  const workflow = await readFile(join(process.cwd(), ".github", "workflows", "release-candidate.yml"), "utf8")
  assert.match(workflow, /install-agy\.sh --dir "\$RUNNER_TEMP\/agy-bin"/u)
  assert.doesNotMatch(workflow, /install-agy\.sh --skip-/u)
})
