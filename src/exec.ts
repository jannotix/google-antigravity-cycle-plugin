import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

/**
 * Windows script runners such as npm and yarn are .cmd shims. Node refuses to spawn them without a
 * shell, and a shell would reopen the injection that the argument allowlist exists to close, so
 * shims are resolved and reported but never executed directly.
 */
export type ExecutableKind = "binary" | "shim"

export interface ResolvedExecutable {
  readonly kind: ExecutableKind
  readonly path: string
}

export async function resolveExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedExecutable | null> {
  if (name.includes("/") || name.includes("\\")) {
    const path = isAbsolute(name) ? name : join(process.cwd(), name)
    return (await isExecutableFile(path)) ? { kind: kindOf(path, platform), path } : null
  }

  const directories = (environment["PATH"] ?? environment["Path"] ?? "").split(delimiter).filter(Boolean)
  const extensions =
    platform === "win32"
      ? (environment["PATHEXT"] ?? DEFAULT_PATHEXT).split(";").filter(Boolean)
      : [""]

  for (const directory of directories) {
    for (const extension of extensions) {
      const path = join(directory, name + extension)
      if (await isExecutableFile(path)) return { kind: kindOf(path, platform), path }
    }
  }

  return null
}

export async function probeVersion(
  name: string,
  args: readonly string[],
  timeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ resolved: ResolvedExecutable; version: string | null } | null> {
  const resolved = await resolveExecutable(name, environment, platform)
  if (resolved === null) return null
  if (resolved.kind === "shim") return { resolved, version: null }

  try {
    const { stdout } = await execFileAsync(resolved.path, [...args], {
      encoding: "utf8",
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    })
    return { resolved, version: stdout.trim().split("\n")[0]?.trim() ?? null }
  } catch {
    return { resolved, version: null }
  }
}

function kindOf(path: string, platform: NodeJS.Platform): ExecutableKind {
  if (platform !== "win32") return "binary"
  return /\.(?:bat|cmd)$/iu.test(path) ? "shim" : "binary"
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (process.platform === "win32") return true
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
