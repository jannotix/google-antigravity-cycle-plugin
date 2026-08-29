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
 * Durable state never lives anywhere the application manages, so neither an update nor an uninstall
 * can destroy workflow state, history, memory or the index.
 *
 * A host-managed plugin directory is deliberately not used. The host may remove it when the plugin is
 * uninstalled, which is right for a plugin's cache and wrong for a signed, append-only record of a
 * project's delivered work: uninstalling would silently destroy the history the product exists to
 * keep. The per-platform locations below outlive both the plugin and the application, and section
 * 1.9's promise is that the user removes this directory deliberately, never that something else
 * removes it for them.
 */
export function resolveDataDirectory(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (configured) return configured

  const path = platform === "win32" ? win32 : posix

  if (platform === "win32") {
    const base = environment["LOCALAPPDATA"]
    if (!base) throw new PathError("LOCALAPPDATA is not set")
    return path.join(base, "Cycle")
  }

  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Cycle")
  }

  const base = environment["XDG_DATA_HOME"] || path.join(homedir(), ".local", "share")
  return path.join(base, PRODUCT_DIRECTORY)
}

export function settingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["ANTIGRAVITY_CONFIG_DIR"] || environment["GEMINI_CONFIG_DIR"]
  return join(configured || join(homedir(), ".gemini", "antigravity-cli"), "settings.json")
}
