import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { collect, readEntries, ROOT, runtimePackage, violations } from "./manifest.mjs"
import { createZip } from "./zip.mjs"

const OUTPUT = join(ROOT, "build")

const source = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"))

const paths = await collect()
const entries = await readEntries(paths)
entries.push({ data: Buffer.from(runtimePackage(source), "utf8"), path: "package.json" })
entries.sort((left, right) => (left.path < right.path ? -1 : 1))

// The check runs on what was actually collected, not on the rules that collected it: a mistake in
// the allowlist has to fail here rather than reach a user.
const rejected = violations(entries.map((entry) => entry.path))
if (rejected.length > 0) {
  console.error(`refusing to package: ${rejected.length} excluded file(s) reached the artifact`)
  for (const item of rejected) console.error(`  ${item.path} — ${item.reason}`)
  process.exit(1)
}

const required = ["dist/server.js", "plugin.json", "mcp_config.json", "hooks.json"]
const missing = required.filter((path) => !entries.some((entry) => entry.path === path))
if (missing.length > 0) {
  console.error(`refusing to package: the artifact is missing ${missing.join(", ")}`)
  console.error("run npm run build first")
  process.exit(1)
}

const archive = createZip(entries)
const name = `cycle-antigravity-${source.version}.zip`
await mkdir(OUTPUT, { recursive: true })
await writeFile(join(OUTPUT, name), archive)

const digest = createHash("sha256").update(archive).digest("hex")
await writeFile(join(OUTPUT, `${name}.sha256`), `${digest}  ${name}\n`, "utf8")

const bytes = entries.reduce((total, entry) => total + entry.data.length, 0)
const grouped = new Map()
for (const entry of entries) {
  const group = entry.path.includes("/") ? entry.path.split("/")[0] : "(root)"
  grouped.set(group, (grouped.get(group) ?? 0) + 1)
}

console.log(`cycle-antigravity ${source.version} — ${entries.length} files, ${mib(bytes)} uncompressed`)
for (const [group, count] of [...grouped].sort()) {
  console.log(`  ${String(count).padStart(4)}  ${group}`)
}
console.log(`\n${join("build", name)}  ${mib(archive.length)}`)
console.log(`sha256  ${digest}`)

function mib(value) {
  return value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${Math.round(value / 1024)} KiB`
}
