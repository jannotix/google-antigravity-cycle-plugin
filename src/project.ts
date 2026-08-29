import { createHash } from "node:crypto"
import { resolve } from "node:path"

export interface Project {
  readonly id: string
  readonly path: string
}

/**
 * Identity is derived from the resolved path rather than stored, so a project keeps its history
 * without a marker file inside the repository.
 */
export function identifyProject(
  directory: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Project {
  const path = resolve(directory || environment["ANTIGRAVITY_PROJECT_DIR"] || environment["CYCLE_PROJECT_DIR"] || process.cwd())
  const normalized = process.platform === "win32" ? path.toLowerCase() : path
  return {
    id: createHash("sha256").update(normalized).digest("hex").slice(0, 32),
    path,
  }
}
