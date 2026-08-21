import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { normalizeInvocation, parseCommand, UnsafeCommand } from "../workflow/commands.ts"
import { DEFAULT_TIMEOUT_SECONDS, type Gate, type GateKind } from "./gates.ts"

/** Node scripts are matched against a fixed list: an arbitrary script is not a verification gate. */
const NODE_SCRIPTS: Readonly<Record<string, GateKind>> = {
  build: "build",
  check: "test",
  e2e: "test",
  lint: "lint",
  test: "test",
  "test:integration": "test",
  "test:unit": "test",
  typecheck: "lint",
  "type-check": "lint",
}

const LOCKFILES: readonly [string, string][] = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

const RUST_GATES: readonly [GateKind, string][] = [
  ["lint", "cargo fmt --check"],
  ["lint", "cargo clippy --all-targets --all-features -- -D warnings"],
  ["test", "cargo test --all-features"],
]

const PYTHON_GATES: readonly [GateKind, string][] = [
  ["test", "pytest"],
  ["lint", "ruff check ."],
  ["lint", "mypy ."],
]

const GO_GATES: readonly [GateKind, string][] = [
  ["build", "go build ./..."],
  ["lint", "go vet ./..."],
  ["test", "go test ./..."],
]

const MAKE_TARGETS: Readonly<Record<string, GateKind>> = {
  build: "build",
  check: "test",
  lint: "lint",
  test: "test",
  verify: "test",
}

export interface DiscoveryReport {
  readonly ecosystems: readonly string[]
  readonly gates: readonly Gate[]
  readonly packageManager: string | null
}

/**
 * Gates come from the architect's declared verification commands and from the project's own
 * scripts, deduplicated by normalised invocation. The architect's commands win a tie: they were
 * written for this change, the project's were written for the project.
 */
export async function discoverGates(
  root: string,
  taskCommands: readonly string[],
): Promise<DiscoveryReport> {
  const gates = new Map<string, Gate>()
  const ecosystems: string[] = []

  const add = (kind: GateKind, text: string, precondition: string): void => {
    let command
    try {
      command = parseCommand(text)
    } catch (error) {
      if (error instanceof UnsafeCommand) return
      throw error
    }
    const key = normalizeInvocation(command)
    if (gates.has(key)) return
    const invocation = [command.program, ...command.arguments].join(" ")
    gates.set(key, {
      executor: { command, kind: "command" },
      invocation,
      kind,
      mandatory: true,
      name: `${kind}:${invocation}`,
      precondition,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    })
  }

  for (const command of taskCommands) {
    add("command", command, "the architect declared this command for a task in this change")
  }

  const manifest = await readJson(join(root, "package.json"))
  const packageManager = manifest === null ? null : await detectPackageManager(root)
  if (manifest !== null) {
    ecosystems.push("node")
    const scripts = (manifest["scripts"] ?? {}) as Record<string, unknown>
    for (const [script, kind] of Object.entries(NODE_SCRIPTS)) {
      if (typeof scripts[script] !== "string") continue
      add(kind, `${packageManager} run ${script}`, `package.json declares the ${script} script`)
    }
  }

  if (await exists(join(root, "Cargo.toml"))) {
    ecosystems.push("rust")
    for (const [kind, text] of RUST_GATES) add(kind, text, "the project is a Cargo workspace")
  }

  if ((await exists(join(root, "pyproject.toml"))) || (await exists(join(root, "tox.ini")))) {
    ecosystems.push("python")
    for (const [kind, text] of PYTHON_GATES) add(kind, text, "the project declares a Python build")
  }

  if (await exists(join(root, "go.mod"))) {
    ecosystems.push("go")
    for (const [kind, text] of GO_GATES) add(kind, text, "the project declares a Go module")
  }

  const targets = await makeTargets(root)
  if (targets.length > 0) {
    ecosystems.push("make")
    for (const target of targets) {
      add(MAKE_TARGETS[target]!, `make ${target}`, `the Makefile declares the ${target} target`)
    }
  }

  return { ecosystems, gates: [...gates.values()], packageManager }
}

export async function detectPackageManager(root: string): Promise<string> {
  for (const [lockfile, manager] of LOCKFILES) {
    if (await exists(join(root, lockfile))) return manager
  }
  return "npm"
}

async function makeTargets(root: string): Promise<string[]> {
  const content = await readText(join(root, "Makefile"))
  if (content === null) return []
  const found = new Set<string>()
  for (const line of content.split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9_.-]+)\s*:(?!=)/u.exec(line)
    const target = match?.[1]
    if (target !== undefined && target in MAKE_TARGETS) found.add(target)
  }
  return [...found].sort()
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const content = await readText(path)
  if (content === null) return null
  try {
    const parsed: unknown = JSON.parse(content)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
