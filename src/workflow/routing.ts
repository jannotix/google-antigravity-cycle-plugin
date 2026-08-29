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
 *
 * They are matched as substrings, and the non-English entries are stems rather than words, so one
 * entry covers a family: "autentic" reads Italian, Spanish and Portuguese at once. A cycle that
 * answers in the language of the request has to route on it too — an English-only scan means a
 * payment change described in any other language takes the quick route with nothing said.
 */
const CRITICAL_MARKERS: readonly [string, readonly string[]][] = [
  [
    "authentication",
    ["authentication", "login", "sign-in", "sign in", "oauth", "sso", "autentic", "authentifi", "anmeldung"],
  ],
  [
    "authorization",
    ["authorization", "permission", "rbac", "access control", "autorizz", "autoriza", "permess", "permiso", "berechtigung"],
  ],
  [
    "cryptography",
    ["cryptography", "encryption", "encrypt", "cipher", "hashing password", "crittograf", "criptograf", "cryptograph", "chiffr", "verschlüssel"],
  ],
  [
    "secrets",
    ["secret", "credential", "api key", "private key", "token store", "segret", "credenzial", "credencial", "geheimnis", "schlüssel"],
  ],
  [
    "persistence",
    ["database migration", "schema migration", "data migration", "migrazione", "migración", "migração", "migration de", "datenbankmigration"],
  ],
  [
    "payments",
    ["payment", "billing", "invoice", "checkout", "subscription", "pagament", "fattur", "abbonament", "factur", "suscripción", "paiement", "zahlung", "rechnung"],
  ],
  [
    "personal-data",
    ["personal data", "gdpr", "pii", "dati personali", "datos personales", "données personnelles", "personenbezogene"],
  ],
  [
    "release",
    ["release", "deployment", "deploy", "publish the package", "rilascio", "distribuzione", "despliegue", "déploiement", "veröffentlich"],
  ],
  [
    "rewrite",
    ["rewrite", "large refactor", "migrate the whole", "re-architect", "riscrittura", "riscrivere", "reescrib", "réécrire", "neuschreib"],
  ],
]

const CRITICAL_PATHS: readonly [string, RegExp][] = [
  ["persistence", /(^|\/)(migrations?|schema)(\/|$)|\.sql$/iu],
  ["packaging", /(^|\/)(installer|packaging|release|docker(file)?)(\/|$)/iu],
  ["deployment", /(^|\/)(deploy|k8s|helm|terraform)(\/|$)/iu],
  ["dependencies", /(^|\/)(package\.json|.*\.lock|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt)$/iu],
  ["ci", /(^|\/)\.github\/workflows(\/|$)/iu],
]

const LARGE_CHANGE = 10

/**
 * Paths named in the request itself. Routing runs before anything has been planned, so the caller
 * has no file list to offer yet; the one place a path is already known is where the person wrote
 * it. Without this the path rules below can only ever be tested against an empty list, which is a
 * guard that reads as armed and never fires.
 */
const PATH_LIKE = /[\w.@-]+(?:\/[\w.@-]+)+|\b[\w-]+\.(?:sql|json|lock|toml|mod|txt|ya?ml)\b/gu

function pathsIn(request: string): string[] {
  return [...new Set(request.match(PATH_LIKE) ?? [])]
}

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
  const paths = [...new Set([...affectedPaths, ...pathsIn(request)])]
  for (const path of paths) {
    for (const [category, pattern] of CRITICAL_PATHS) {
      if (pattern.test(path)) critical.add(category)
    }
  }
  if (paths.length > LARGE_CHANGE) critical.add("breadth")

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
