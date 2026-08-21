import type { WorkflowMode } from "./machine.ts"

export type Preference = "auto" | "full" | "quick"

export interface RoutingDecision {
  readonly critical: readonly string[]
  readonly mode: WorkflowMode
  readonly rationale: string
  readonly userPromoted: boolean
}

/**
 * Markers are deliberately narrow. A routing rule that fires on "api" or "update" sends every
 * request to the full cycle, which turns the quick route into decoration and makes the product too
 * expensive to use for the small changes it should stay out of the way for.
 */
const CRITICAL_MARKERS: readonly [string, readonly string[]][] = [
  ["authentication", ["authentication", "login", "sign-in", "sign in", "oauth", "sso"]],
  ["authorization", ["authorization", "permission", "rbac", "access control"]],
  ["cryptography", ["cryptography", "encryption", "encrypt", "cipher", "hashing password"]],
  ["secrets", ["secret", "credential", "api key", "private key", "token store"]],
  ["persistence", ["database migration", "schema migration", "data migration"]],
  ["payments", ["payment", "billing", "invoice", "checkout", "subscription"]],
  ["personal-data", ["personal data", "gdpr", "pii"]],
  ["release", ["release", "deployment", "deploy", "publish the package"]],
  ["rewrite", ["rewrite", "large refactor", "migrate the whole", "re-architect"]],
]

const CRITICAL_PATHS: readonly [string, RegExp][] = [
  ["persistence", /(^|\/)(migrations?|schema)(\/|$)|\.sql$/iu],
  ["packaging", /(^|\/)(installer|packaging|release|docker(file)?)(\/|$)/iu],
  ["deployment", /(^|\/)(deploy|k8s|helm|terraform)(\/|$)/iu],
  ["dependencies", /(^|\/)(package\.json|.*\.lock|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt)$/iu],
  ["ci", /(^|\/)\.github\/workflows(\/|$)/iu],
]

const LARGE_CHANGE = 10

export function route(
  request: string,
  affectedPaths: readonly string[],
  preference: Preference,
): RoutingDecision {
  if (preference === "full") {
    return {
      critical: [],
      mode: "full",
      rationale: "the full cycle was requested explicitly",
      userPromoted: true,
    }
  }

  const critical = new Set<string>()
  const normalized = request.toLowerCase()
  for (const [category, markers] of CRITICAL_MARKERS) {
    if (markers.some((marker) => normalized.includes(marker))) critical.add(category)
  }
  for (const path of affectedPaths) {
    for (const [category, pattern] of CRITICAL_PATHS) {
      if (pattern.test(path)) critical.add(category)
    }
  }
  if (affectedPaths.length > LARGE_CHANGE) critical.add("breadth")

  if (preference === "quick") {
    return {
      critical: [...critical],
      mode: "quick",
      rationale:
        critical.size === 0
          ? "the quick route was requested and no critical signal was found"
          : `the quick route was requested despite ${[...critical].join(", ")}`,
      userPromoted: false,
    }
  }

  return {
    critical: [...critical],
    mode: critical.size === 0 ? "quick" : "full",
    rationale:
      critical.size === 0
        ? "no critical signal in the request or the affected paths"
        : `critical signals: ${[...critical].join(", ")}`,
    userPromoted: false,
  }
}
