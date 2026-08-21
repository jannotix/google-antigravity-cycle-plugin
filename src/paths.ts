import { homedir } from "node:os"
import { join, win32, posix } from "node:path"

const PRODUCT_DIRECTORY = "cycle"

export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathError"
  }
}

/**
 * Durable state never lives inside the application installation directory, so application
 * updates cannot destroy workflow state, history, memory or the code intelligence index.
 */
export function resolveDataDirectory(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (configured) return configured

  const path = platform === "win32" ? win32 : posix

  const provided = environment["ANTIGRAVITY_CYCLE_DATA"] || environment["CYCLE_DATA_DIR"] || environment["CLAUDE_PLUGIN_DATA"]
  if (provided) return path.join(provided, PRODUCT_DIRECTORY)

  if (platform === "win32") {
    const base = environment["LOCALAPPDATA"]
    if (!base) throw new PathError("LOCALAPPDATA is not set")
    return path.join(base, "Antigravity Cycle")
  }

  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Antigravity Cycle")
  }

  const base = environment["XDG_DATA_HOME"] || path.join(homedir(), ".local", "share")
  return path.join(base, "antigravity-cycle")
}

export function settingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["ANTIGRAVITY_CONFIG_DIR"] || environment["GEMINI_CONFIG_DIR"]
  return join(configured || join(homedir(), ".gemini"), "config", "cycle", "config.json")
}
