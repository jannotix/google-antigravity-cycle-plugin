import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MANUAL = join(ROOT, "docs", "manual.md")

async function shippedSkills(): Promise<string[]> {
  const entries = await readdir(join(ROOT, "skills"), { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function documented(): Promise<string[]> {
  const text = await readFile(MANUAL, "utf8")
  const names = [...text.matchAll(/`\/cycle:([a-z-]+)/gu)].map((match) => match[1] as string)
  return [...new Set(names)].sort()
}

/** The frontmatter name is what Claude Code registers, not the directory it sits in. */
async function declaredNames(): Promise<string[]> {
  const names: string[] = []
  for (const directory of await shippedSkills()) {
    const text = await readFile(join(ROOT, "skills", directory, "SKILL.md"), "utf8")
    const name = /^name:\s*(\S+)\s*$/mu.exec(text.split("---")[1] ?? "")?.[1]
    assert.ok(name, `skills/${directory}/SKILL.md declares no name`)
    names.push(name)
  }
  return names.sort()
}

// Certification 3.13.
test("every command in the manual exists, and every command exists in the manual", async () => {
  const skills = await shippedSkills()
  const inManual = await documented()

  assert.deepEqual(
    inManual.filter((name) => !skills.includes(name)),
    [],
    "the manual documents a command that does not ship",
  )
  assert.deepEqual(
    skills.filter((name) => !inManual.includes(name)),
    [],
    "a command ships that the manual does not document",
  )
})

test("a skill's declared name matches the directory it ships in", async () => {
  assert.deepEqual(await declaredNames(), await shippedSkills())
})

// Certification 3.1, 3.3, 3.9, 3.10, 3.11: the command surface the specification promises is the
// command surface that ships. A row in section 15 with no skill behind it is a command the manual
// documents and the user cannot run.
test("every command the specification lists ships as a skill", async () => {
  const promised = [
    "architect",
    "cancel",
    "doctor",
    "evidence",
    "executor",
    "export",
    "goal",
    "help",
    "history",
    "index",
    "judge",
    "limits",
    "memory",
    "models",
    "pause",
    "permissions",
    "resume",
    "retry",
    "review",
    "run",
    "security",
    "setup",
    "status",
    "tasks",
  ]
  assert.deepEqual(await shippedSkills(), promised)
})

test("every skill states what it is for in a description a router can act on", async () => {
  for (const directory of await shippedSkills()) {
    const frontmatter = (await readFile(join(ROOT, "skills", directory, "SKILL.md"), "utf8")).split(
      "---",
    )[1]
    const description = /^description:\s*(.+)$/mu.exec(frontmatter ?? "")?.[1] ?? ""
    assert.ok(description.length > 60, `${directory} needs a description that says when to use it`)
    assert.ok(description.length < 1_024, `${directory} has a description too long to be read`)
  }
})
