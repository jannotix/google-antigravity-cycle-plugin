import { constants } from "node:fs"
import { access, mkdir, readFile, statfs } from "node:fs/promises"
import { freemem } from "node:os"
import { isAbsolute, relative } from "node:path"

import { INHERIT, ROLES, type Configuration, type Role } from "./config.ts"
import { probeVersion, type ExecutableKind } from "./exec.ts"
import { settingsPath } from "./paths.ts"
import { describeProviders, type RoleProvider } from "./providers.ts"
import type { Runtime } from "./runtime.ts"
import { keyPermissions, verifyCheckpoints } from "./store/checkpoints.ts"
import type { StoreMode } from "./store/database.ts"
import { verifyHistory } from "./store/history.ts"
import { graphSize } from "./store/graph.ts"
import { CURRENT_SCHEMA_VERSION } from "./store/migrations.ts"

const MINIMUM_NODE_MAJOR = 22
const MEMORY_RESERVE_BYTES = 1024 ** 3
const DISK_RESERVE_BYTES = 2 * 1024 ** 3
const PROBE_TIMEOUT_MS = 4_000

export type Severity = "ok" | "warn" | "error"

export interface Finding {
  readonly code: string
  readonly message: string
  readonly severity: Severity
}

export interface PackageManager {
  readonly kind: ExecutableKind
  readonly name: string
  readonly version: string | null
}

export interface DoctorReport {
  readonly configuration: {
    readonly gateStrictness: string
    readonly maxRepairCycles: number
    readonly roles: Readonly<Record<Role, { effort: string; model: string }>>
  }
  readonly findings: readonly Finding[]
  readonly models: {
    readonly availableModelsAllowlist: readonly string[] | null
    readonly baseUrlHost: string | null
    readonly credentialMode: "gateway-credential" | "subscription-or-default"
    readonly distinctProviders: number
    readonly distinctRoleModels: number
    readonly roles: Readonly<Record<Role, RoleProvider>>
    readonly routedElsewhere: boolean
    readonly subagentModelOverride: string | null
  }
  readonly ok: boolean
  readonly runtime: {
    readonly arch: string
    readonly git: string | null
    readonly node: string
    readonly packageManagers: readonly PackageManager[]
    readonly platform: string
    readonly wsl: boolean
  }
  readonly storage: {
    readonly availableDiskBytes: number | null
    readonly availableMemoryBytes: number
    readonly dataDirectory: string
    readonly writable: boolean
  }
  readonly store: {
    readonly graph: { edges: number; files: number; nodes: number } | null
    readonly historyEntries: number | null
    readonly mode: StoreMode | "unavailable"
    readonly schemaVersion: number | null
  }
  readonly version: string
}

export async function diagnose(
  cycle: Runtime,
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
  const findings: Finding[] = []
  const configuration = cycle.configuration

  const runtime = await probeRuntime(findings)
  const storage = await probeStorage(cycle, findings)
  const models = await probeModels(configuration, environment, findings)
  const store = probeStore(cycle, findings)
  probeIntegrity(cycle, findings)

  for (const problem of configuration.invalid) {
    findings.push({ code: "config.invalid", message: problem, severity: "error" })
  }

  if (configuration.unknown.length > 0) {
    findings.push({
      code: "config.unknown",
      message:
        `These options are set but this build does not read them, so they change nothing: ` +
        `${configuration.unknown.join(", ")}.`,
      severity: "warn",
    })
  }

  const roles = {} as Record<Role, { effort: string; model: string }>
  for (const role of ROLES) {
    roles[role] = {
      effort: configuration.roles[role].effort,
      model: configuration.roles[role].model,
    }
  }

  if (findings.every((finding) => finding.severity === "ok")) {
    findings.push({ code: "ready", message: "No problems detected.", severity: "ok" })
  }

  return {
    configuration: {
      gateStrictness: configuration.gateStrictness,
      maxRepairCycles: configuration.maxRepairCycles,
      roles,
    },
    findings,
    models,
    ok: !findings.some((finding) => finding.severity === "error"),
    runtime,
    storage,
    store,
    version,
  }
}

/**
 * The chain and its signatures, checked at startup because a history nobody verifies is a
 * history nobody can rely on. Also refuses a data directory inside the project: the store and
 * the signing key would become part of every candidate the project verifies, and the secret
 * scanner would find the key exactly where it should never be.
 */
function probeIntegrity(cycle: Runtime, findings: Finding[]): void {
  const inside = relative(cycle.project.path, cycle.dataDirectory)
  if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
    findings.push({
      code: "storage.inside_project",
      message:
        `The data directory (${cycle.dataDirectory}) is inside the project. Move it: the ` +
        "store and the signing key would be part of every candidate this project verifies.",
      severity: "error",
    })
  }

  const database = cycle.store()
  if (database === undefined) return

  const chain = verifyHistory(database)
  if (!chain.valid) {
    findings.push({
      code: "history.chain",
      message:
        `The project history does not verify at sequence ${chain.sequence} (${chain.reason}). ` +
        "It has been altered since it was written.",
      severity: "error",
    })
    return
  }

  // Section 17: a signature is worth the exclusivity of the key that made it. Read from the
  // filesystem each time, because a key restricted at creation can be loosened afterwards.
  const permissions = keyPermissions(cycle.dataDirectory)
  if (permissions.exists && !permissions.restricted) {
    findings.push({
      code: "history.key_permissions",
      message:
        `The checkpoint signing key is not restricted to this account (${permissions.detail}). ` +
        "Anyone who can read it can forge a checkpoint signature, and a forged checkpoint makes a " +
        "tampered history verify.",
      severity: "error",
    })
  }

  const signatures = verifyCheckpoints(database)
  if (!signatures.valid) {
    findings.push({
      code: "history.signature",
      message:
        `The signed checkpoint at sequence ${signatures.sequence} does not verify ` +
        `(${signatures.reason}).`,
      severity: "error",
    })
  }
}

function probeStore(cycle: Runtime, findings: Finding[]): DoctorReport["store"] {
  const database = cycle.store()
  if (database === undefined) {
    findings.push({
      code: "store.open",
      message: `The store could not be opened: ${cycle.storeFailure()?.message ?? "unknown reason"}`,
      severity: "error",
    })
    return { graph: null, historyEntries: null, mode: "unavailable", schemaVersion: null }
  }

  if (database.mode === "safe_read_only") {
    findings.push({
      code: "store.newer",
      message:
        `The store was written by schema version ${database.schemaVersion}; this build supports ` +
        `${CURRENT_SCHEMA_VERSION}. It is open read-only and no workflow can run until the ` +
        "plugin is updated.",
      severity: "error",
    })
  }

  const row = database.get<{ entries: number }>("select count(*) as entries from history")
  return {
    graph: graphSize(database, cycle.project.id),
    historyEntries: row?.entries ?? 0,
    mode: database.mode,
    schemaVersion: database.schemaVersion,
  }
}

async function probeRuntime(findings: Finding[]): Promise<DoctorReport["runtime"]> {
  const major = Number(process.versions.node.split(".")[0])
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    findings.push({
      code: "runtime.node",
      message: `Node ${process.versions.node} is below the required ${MINIMUM_NODE_MAJOR}.`,
      severity: "error",
    })
  }

  const git = await probeVersion("git", ["--version"], PROBE_TIMEOUT_MS)
  if (git === null) {
    findings.push({
      code: "runtime.git",
      message: "Git was not found. Implementation workflows require Git for isolation and delivery.",
      severity: "error",
    })
  }

  const packageManagers: PackageManager[] = []
  for (const name of ["npm", "bun", "pnpm", "yarn"]) {
    const probe = await probeVersion(name, ["--version"], PROBE_TIMEOUT_MS)
    if (probe !== null) {
      packageManagers.push({ kind: probe.resolved.kind, name, version: probe.version })
    }
  }

  return {
    arch: process.arch,
    git: git?.version ?? null,
    node: process.versions.node,
    packageManagers,
    platform: process.platform,
    wsl: await detectWsl(),
  }
}

async function probeStorage(
  cycle: Runtime,
  findings: Finding[],
): Promise<DoctorReport["storage"]> {
  const dataDirectory = cycle.dataDirectory

  let writable = false
  try {
    await mkdir(dataDirectory, { recursive: true })
    await access(dataDirectory, constants.W_OK)
    writable = true
  } catch {
    findings.push({
      code: "storage.writable",
      message: `The data directory is not writable: ${dataDirectory}`,
      severity: "error",
    })
  }

  let availableDiskBytes: number | null = null
  try {
    const stats = await statfs(dataDirectory)
    availableDiskBytes = Number(stats.bavail) * Number(stats.bsize)
  } catch {
    findings.push({
      code: "storage.disk",
      message: "Available disk space could not be measured; admission control will defer work.",
      severity: "warn",
    })
  }

  if (availableDiskBytes !== null && availableDiskBytes < DISK_RESERVE_BYTES) {
    findings.push({
      code: "storage.disk",
      message: `Free disk space is below the ${gibibytes(DISK_RESERVE_BYTES)} reserve.`,
      severity: "warn",
    })
  }

  const availableMemoryBytes = freemem()
  if (availableMemoryBytes < MEMORY_RESERVE_BYTES) {
    findings.push({
      code: "storage.memory",
      message: `Available memory is below the ${gibibytes(MEMORY_RESERVE_BYTES)} reserve.`,
      severity: "warn",
    })
  }

  return { availableDiskBytes, availableMemoryBytes, dataDirectory, writable }
}

async function probeModels(
  configuration: Configuration,
  environment: NodeJS.ProcessEnv,
  findings: Finding[],
): Promise<DoctorReport["models"]> {
  const subagentModelOverride = environment["CLAUDE_CODE_SUBAGENT_MODEL"]?.trim() || null
  if (subagentModelOverride !== null) {
    findings.push({
      code: "models.override",
      message:
        `CLAUDE_CODE_SUBAGENT_MODEL is set to "${subagentModelOverride}". It overrides every role ` +
        "assignment, so the roles are not running on the models configured here.",
      severity: "warn",
    })
  }

  const paths = describeProviders(configuration, environment)

  if (paths.credentialVariable !== null) {
    findings.push({
      code: "models.credential",
      message:
        `${paths.credentialVariable} is set, so it replaces the saved login for this session and ` +
        "every role is billed per token to that credential rather than to a Claude subscription.",
      severity: "warn",
    })
  }

  if (paths.unroutable.length !== 0) {
    findings.push({
      code: "models.unroutable",
      message:
        `${paths.unroutable.join(", ")} names a provider, but ANTHROPIC_BASE_URL is not set to a ` +
        "gateway, so the request goes to the Anthropic API, which does not serve it. Either point " +
        "the session at a gateway that routes these names, or configure a model the session can " +
        "reach.",
      severity: "warn",
    })
  }

  if (paths.gateway && paths.distinctProviders === 1) {
    findings.push({
      code: "models.providers",
      message:
        `A gateway is configured at ${paths.endpoint}, but all five roles resolve through the same ` +
        "provider path. Per-role provider independence is not in effect: name the provider in the " +
        "model identifier (provider/model) for the roles that should differ.",
      severity: "warn",
    })
  }

  const availableModelsAllowlist = await readAllowlist(environment)
  const assigned = ROLES.filter((role) => role !== "operator").map(
    (role) => configuration.roles[role].model,
  )

  if (availableModelsAllowlist !== null) {
    const blocked = [...new Set(assigned)].filter(
      (model) => model !== INHERIT && !allowlisted(model, availableModelsAllowlist),
    )
    if (blocked.length !== 0) {
      findings.push({
        code: "models.allowlist",
        message:
          `availableModels does not permit ${blocked.join(", ")}. Claude Code substitutes a ` +
          "different model, so the configured assignment is not what runs.",
        severity: "warn",
      })
    }
  }

  const judges = [
    configuration.roles.functional_reviewer.model,
    configuration.roles.security_reviewer.model,
    configuration.roles.arbiter.model,
  ]
  if (new Set(judges).size === 1) {
    findings.push({
      code: "models.correlation",
      message:
        judges[0] === INHERIT
          ? "Both reviewers and the arbiter inherit the session model. The separation of powers " +
            "still holds, but correlated model errors are more likely. Assign distinct models to " +
            "make the reviews genuinely independent."
          : "Both reviewers and the arbiter use the same model. Correlated model errors are more " +
            "likely than the three-verdict structure suggests.",
      severity: "warn",
    })
  }

  const arbiter = configuration.roles.arbiter.model
  if (arbiter !== INHERIT && arbiter === configuration.roles.architect.model) {
    findings.push({
      code: "models.correlation",
      message:
        "The arbiter and the architect use the same model. The arbiter exists to judge the request " +
        "independently of the plan; sharing a model weakens exactly that boundary.",
      severity: "warn",
    })
  }

  return {
    availableModelsAllowlist,
    baseUrlHost: paths.endpoint,
    credentialMode: paths.credentialMode,
    distinctProviders: paths.distinctProviders,
    distinctRoleModels: new Set(assigned).size,
    roles: paths.roles,
    routedElsewhere: paths.gateway,
    subagentModelOverride,
  }
}

async function readAllowlist(environment: NodeJS.ProcessEnv): Promise<string[] | null> {
  try {
    const raw = await readFile(settingsPath(environment), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const value = (parsed as Record<string, unknown>)["availableModels"]
    if (!Array.isArray(value)) return null
    return value.filter((entry): entry is string => typeof entry === "string")
  } catch {
    return null
  }
}

function allowlisted(model: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => model === entry || model.startsWith(entry))
}

async function detectWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false
  try {
    return (await readFile("/proc/version", "utf8")).toLowerCase().includes("microsoft")
  } catch {
    return false
  }
}

function gibibytes(bytes: number): string {
  return `${bytes / 1024 ** 3} GiB`
}
