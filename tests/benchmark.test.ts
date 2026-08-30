import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

test("the filesystem benchmark indexes every supported file and proves the warm pass", () => {
  const output = mkdtempSync(join(tmpdir(), "cycle-benchmark-test-"))
  try {
    const child = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "benchmark-500k.mjs"),
        "--files", "1000",
        "--minimum-free-memory-gib", "1",
        "--minimum-free-disk-gib", "1",
        "--output-dir", output,
      ],
      { encoding: "utf8", timeout: 120_000 },
    )
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
    const report = JSON.parse(readFileSync(join(output, "benchmark-500k.json"), "utf8")) as {
      cold: { files: number; skipped: number; updated: number }
      generatedFiles: number
      status: string
      warm: { unchanged: number; updated: number }
    }
    assert.equal(report.status, "PASS")
    assert.equal(report.generatedFiles, 1000)
    assert.deepEqual(
      { files: report.cold.files, skipped: report.cold.skipped, updated: report.cold.updated },
      { files: 1000, skipped: 0, updated: 1000 },
    )
    assert.deepEqual(
      { unchanged: report.warm.unchanged, updated: report.warm.updated },
      { unchanged: 1000, updated: 0 },
    )
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
