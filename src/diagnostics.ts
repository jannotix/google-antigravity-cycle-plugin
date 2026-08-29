import { constants } from "node:fs"
import { access, mkdir, readFile, stat, statfs } from "node:fs/promises"
import { freemem } from "node:os"
import { isAbsolute, join, relative } from "node:path"

import { INHERIT, ROLES, type Configuration, type Role } from "./config.ts"
import { probeVersion, type ExecutableKind } from "./exec.ts"
import { subagentModelFor } from "./roles.ts"
import { settingsPath } from "./paths.ts"
import { describeProviders, type RoleProvider } from "./providers.ts"
import type { Runtime } from "./runtime.ts"
import { keyPermissions, verifyCheckpoints } from "./store/checkpoints.ts"
import type { StoreMode } from "./store/database.ts"
import { verifyHistory } from "./store/history.ts"
import { graphSize } from "./store/graph.ts"
import { CURRENT_SCHEMA_VERSION } from "./store/migrations.ts"

const MINIMUM_NODE_MAJOR = 26
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
    readonly blank: number
    readonly delivered: number
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
    /**
     * How long this server process has been answering. The configuration reaches it once, in the
     * environment it was given at spawn, so a process older than the last change to that
     * configuration is reporting what was true when it started. The version says which build is
     * running and answers nothing about when — reading freshness out of it has produced the wrong
     * conclusion in both directions.
     */
    readonly startedMinutesAgo: number
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

/** Best-effort: a diagnostic that fails because its own counter file is missing tells nobody anything. */
async function guardAttribution(
  dataDirectory: string,
): Promise<{ attributed: number; unattributed: number } | null> {
  try {
    const raw = await readFile(join(dataDirectory, "guard-attribution.json"), "utf8")
    const parsed = JSON.parse(raw) as { attributed?: number; unattributed?: number }
    return {
      attributed: Number(parsed.attributed ?? 0),
      unattributed: Number(parsed.unattributed ?? 0),
    }
  } catch {
    return null
  }
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

  // A server holds the environment it was given at spawn, so one older than the last write to the
  // settings file is answering with what was true then. Saying it only when it is true keeps it out
  // of the reader's way the rest of the time, and puts a measurement where a guess has twice gone
  // the wrong way.
  // Both sides used to be floored to whole minutes, so during this process's first minute the
  // comparison read 0 < 0 and the warning disappeared exactly when a settings edit was freshest.
  // Comparing the instants keeps it honest at any age.
  const settingsWritten = await writtenAt(settingsPath(environment))
  const processStarted = Date.now() - process.uptime() * 1000
  if (settingsWritten !== null && settingsWritten > processStarted) {
    const settingsChanged = Math.max(0, Math.floor((Date.now() - settingsWritten) / 60_000))
    findings.push({
      code: "runtime.stale_configuration",
      message:
        `The settings file was written ${settingsChanged} minutes ago and this server started ` +
        `${runtime.startedMinutesAgo} minutes ago, so it is answering with the configuration as it ` +
        "stood before that change. Reload the plugins or restart to pick it up; nothing below " +
        "reflects the newer settings.",
      severity: "warn",
    })
  }

  if (configuration.delivered === 0) {
    findings.push({
      code: "config.undelivered",
      message:
        (configuration.blank > 0
          ? `All ${configuration.blank} option variables reached this process empty, so the host ` +
            "resolved none of the values configured for this plugin. "
          : "No plugin option reached this process. ") +
        "Nothing configured here is being applied: every role is running on the session model and " +
        "the defaults below are in force.",
      severity: "warn",
    })
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

  // Layer two of the separation of powers identifies a role from fields the host supplies. If those
  // fields are renamed it recognises nothing, treats every call as the user's own session, and stops
  // being a boundary without failing — which is exactly the kind of silence this product exists to
  // refuse. The guard counts what it attributed; a long run of calls with no role recognised is what
  // that blindness looks like from outside.
  const attribution = await guardAttribution(storage.dataDirectory)
  if (attribution !== null && attribution.unattributed >= 20 && attribution.attributed === 0) {
    findings.push({
      code: "guard.unattributed",
      message:
        `The role guard has seen ${attribution.unattributed} tool calls and recognised a Cycle ` +
        "role in none of them. Either no governed cycle has run on this installation, or the host " +
        "changed the payload fields the guard reads and the second of the three separation layers " +
        "is no longer enforcing anything. The first and third layers do not depend on it.",
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
      blank: configuration.blank,
      delivered: configuration.delivered,
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

/** "a and b" for two, "a, b and c" beyond that: the warning is read, not parsed. */
function listed(items: readonly string[]): string {
  if (items.length < 3) return items.join(" and ")
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
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

/** How long ago a file was last written, or null when it cannot be read. */
/** When the file was last written, or null when it is not there to be read. */
async function writtenAt(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
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
    startedMinutesAgo: Math.floor(process.uptime() / 60),
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
  const subagentModelOverride = null

  const paths = describeProviders(configuration, environment)

  if (paths.credentialVariable !== null) {
    findings.push({
      code: "models.credential",
      message:
        `${paths.credentialVariable} is set, so it changes how the host authenticates this session.`,
      severity: "warn",
    })
  }

  if (paths.unroutable.length !== 0) {
    findings.push({
      code: "models.unroutable",
      message:
        `Antigravity cannot serve these configured model tiers: ${paths.unroutable.join(", ")}.`,
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
          `availableModels does not permit ${blocked.join(", ")}. Antigravity may substitute a ` +
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

  // Antigravity exposes the native inherit, flash and pro tiers. The check below keeps a future
  // host change from silently collapsing two distinct configured tiers into one runtime choice.
  const advisory: readonly Role[] = [
    "architect",
    "executor",
    "functional_reviewer",
    "security_reviewer",
    "arbiter",
  ]
  const collapsed = new Map<string, { model: string; role: Role }[]>()
  const inexpressible: string[] = []
  for (const role of advisory) {
    const model = configuration.roles[role].model
    if (model === INHERIT) continue
    const alias = subagentModelFor(model)
    if (alias === null) {
      inexpressible.push(`${role} (${model})`)
      continue
    }
    collapsed.set(alias, [...(collapsed.get(alias) ?? []), { model, role }])
  }

  // Two roles set to the same model is a decision, not a surprise, and saying otherwise trains the
  // reader to skip warnings. What is worth saying is that two models chosen to differ arrive as one.
  const JUDGES: readonly Role[] = ["arbiter", "functional_reviewer", "security_reviewer"]
  for (const [alias, entries] of collapsed) {
    if (new Set(entries.map((entry) => entry.model)).size < 2) continue
    const roles = entries.map((entry) => entry.role)
    const judging = roles.filter((role) => JUDGES.includes(role))
    findings.push({
      code: "models.subagent_collapse",
      message:
        `${listed(roles)} are configured to different tiers that invoke_subagent cannot tell ` +
        `apart: each reaches it as "${alias}". ` +
        (judging.length > 1
          ? `In the advisory commands ${listed(judging)} therefore return verdicts from one model, ` +
            "not from the separate ones the configuration names. "
          : "In the advisory commands they run on one model rather than the separate ones " +
            "configured. ") +
        "Use distinct native tiers where Antigravity exposes them.",
      severity: "warn",
    })
  }

  if (inexpressible.length > 0) {
    findings.push({
      code: "models.subagent_unavailable",
      message:
        `Antigravity invoke_subagent cannot express ${inexpressible.join(", ")}; those roles ` +
        "fall back to the session model.",
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
