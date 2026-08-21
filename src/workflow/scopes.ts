/**
 * Write scopes decide what the executor was authorized to touch, and the same comparison has to
 * hold in two places: the architect's plan, where two tasks writing the same area need an ordering,
 * and reconciliation, where a changed path is either inside what was authorized or the task is
 * rejected. One comparison, used by both — two would eventually disagree, and the disagreement
 * would be the boundary quietly opening.
 */

/** Windows and macOS resolve paths without regard to case; a comparison that ignores that either
 * refuses a legitimate write or accepts an unauthorized one, depending on which way the case fell. */
export function caseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin"
}

export function normalizeScope(scope: string): string {
  return scope.replaceAll("\\", "/").replace(/\/+$/u, "").trim()
}

function comparable(scope: string, platform: NodeJS.Platform): string {
  const normalized = normalizeScope(scope)
  return caseInsensitive(platform) ? normalized.toLowerCase() : normalized
}

/** A scope covers a path when it is the path itself or one of its ancestors. */
export function inScope(
  path: string,
  scope: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const target = comparable(path, platform)
  const prefix = comparable(scope, platform)
  if (!prefix || !target) return false
  return target === prefix || target.startsWith(`${prefix}/`)
}

export function insideAny(
  path: string,
  scopes: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return scopes.some((scope) => inScope(path, scope, platform))
}

/** Two scope sets overlap when either covers anything the other covers. */
export function scopesOverlap(
  left: readonly string[],
  right: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return left.some((a) => right.some((b) => inScope(a, b, platform) || inScope(b, a, platform)))
}
