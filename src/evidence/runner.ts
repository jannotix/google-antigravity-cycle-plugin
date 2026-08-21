import { spawn } from "node:child_process"
import { basename, dirname, join } from "node:path"
import { stat } from "node:fs/promises"

import { assertSafe, type SafeCommand } from "../workflow/commands.ts"
import { resolveExecutable } from "../exec.ts"
import { outputDigest, outputHash } from "./digest.ts"

export const MAX_OUTPUT_BYTES = 1_024 * 1_024

export interface RunOutcome {
  readonly exitCode: number | null
  /** Exactly what was executed, after shim resolution. Reproducible by hand. */
  readonly invocation: string
  readonly output: string
  readonly outputDigest: string
  readonly timedOut: boolean
  /** Set when the gate could not run at all; the gate is recorded as skipped, never as passed. */
  readonly unavailable: string | null
}

/**
 * npm, npx, pnpm, pnpx and yarn are `.cmd` shims on Windows, and Node refuses to spawn a batch file
 * without a shell. A shell would reopen the injection that the argument allowlist exists to close,
 * so each shim is resolved to the real script it wraps and that script is run under this process's
 * own Node. The list is explicit: an unknown shim is reported unavailable, never shelled out to.
 */
const SHIM_ENTRY_POINTS: Readonly<Record<string, readonly string[]>> = {
  npm: ["node_modules/npm/bin/npm-cli.js"],
  npx: ["node_modules/npm/bin/npx-cli.js"],
  pnpm: ["node_modules/pnpm/bin/pnpm.cjs", "node_modules/pnpm/bin/pnpm.js"],
  pnpx: ["node_modules/pnpm/bin/pnpx.cjs", "node_modules/pnpm/bin/pnpx.js"],
  yarn: ["node_modules/yarn/bin/yarn.js"],
}

export interface Runnable {
  readonly arguments: readonly string[]
  readonly file: string
}

export async function resolveRunnable(
  program: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Runnable | { unavailable: string }> {
  const resolved = await resolveExecutable(program, environment, platform)
  if (resolved === null) return { unavailable: `${program} was not found on PATH` }
  if (resolved.kind === "binary") return { arguments: [], file: resolved.path }

  const name = basename(resolved.path).replace(/\.(cmd|bat)$/iu, "").toLowerCase()
  const entries = SHIM_ENTRY_POINTS[name]
  if (entries === undefined) {
    return {
      unavailable:
        `${program} resolves to the shim ${resolved.path}, which has no known entry point; ` +
        "gates never fall back to a shell",
    }
  }

  for (const entry of entries) {
    const candidate = join(dirname(resolved.path), ...entry.split("/"))
    if (await isFile(candidate)) return { arguments: [candidate], file: process.execPath }
  }

  return {
    unavailable:
      `${program} resolves to the shim ${resolved.path} but its entry point is missing ` +
      `(looked for ${entries.join(", ")})`,
  }
}

export interface RunOptions {
  readonly cwd: string
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly timeoutSeconds: number
}

export async function runCommand(
  command: SafeCommand,
  options: RunOptions,
): Promise<RunOutcome> {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform

  // The plan validator applied these rules already. They are applied again here because the plan is
  // not the only way a command reaches this function.
  try {
    assertSafe(command.program, command.arguments)
  } catch (error) {
    return unavailable(command, error instanceof Error ? error.message : String(error))
  }

  const runnable = await resolveRunnable(command.program, environment, platform)
  if ("unavailable" in runnable) return unavailable(command, runnable.unavailable)

  const args = [...runnable.arguments, ...command.arguments]
  const invocation = [runnable.file, ...args].join(" ")

  return await new Promise<RunOutcome>((resolve) => {
    const child = spawn(runnable.file, args, {
      cwd: options.cwd,
      env: {
        ...environment,
        // Verification is never interactive and its output is digested, so colour escapes would
        // make two identical runs produce two different digests.
        CI: "1",
        NO_COLOR: "1",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    const hash = outputHash()
    const kept: Buffer[] = []
    let keptBytes = 0
    let timedOut = false
    let settled = false

    const absorb = (chunk: Buffer): void => {
      hash.update(chunk)
      if (keptBytes >= MAX_OUTPUT_BYTES) return
      const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - keptBytes)
      kept.push(slice)
      keptBytes += slice.byteLength
    }
    child.stdout.on("data", absorb)
    child.stderr.on("data", absorb)

    const timer = setTimeout(() => {
      timedOut = true
      terminate(child, platform)
    }, options.timeoutSeconds * 1_000)

    const finish = (exitCode: number | null, failure?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const output = Buffer.concat(kept).toString("utf8")
      resolve({
        exitCode,
        invocation,
        output: failure === undefined ? output : `${output}\n${failure}`.trim(),
        outputDigest: hash.digest("hex"),
        timedOut,
        unavailable: null,
      })
    }

    child.on("error", (error) => finish(null, `could not run ${command.program}: ${error.message}`))
    child.on("close", (code) => finish(code))
  })
}

/**
 * ponytail: taskkill /T ends the process tree. Killing only the child would leave the test runner
 * a script runner spawned still holding the worktree after a timeout.
 */
function terminate(child: ReturnType<typeof spawn>, platform: NodeJS.Platform): void {
  if (child.pid === undefined) return
  if (platform !== "win32") {
    child.kill("SIGKILL")
    return
  }
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
  killer.on("error", () => child.kill("SIGKILL"))
}

function unavailable(command: SafeCommand, reason: string): RunOutcome {
  return {
    exitCode: null,
    invocation: [command.program, ...command.arguments].join(" "),
    output: "",
    outputDigest: outputDigest(""),
    timedOut: false,
    unavailable: reason,
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
