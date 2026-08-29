import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type Role = "architect" | "executor" | "functional_reviewer" | "security_reviewer" | "arbiter" | "operator"
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export type GateStrictness = "advisory" | "standard" | "strict"
export type ModelTier = "inherit" | "flash" | "pro"

export const ROLES: readonly Role[] = ["architect", "executor", "functional_reviewer", "security_reviewer", "arbiter", "operator"]
export const INHERIT: ModelTier = "inherit"

export interface RoleSettings { readonly effort: Effort; readonly model: ModelTier }
export interface Configuration {
  readonly blank: number
  readonly dataDirectory: string | undefined
  readonly delivered: number
  readonly gateStrictness: GateStrictness
  readonly invalid: readonly string[]
  readonly maxRepairCycles: number
  readonly roles: Readonly<Record<Role, RoleSettings>>
  readonly securityProofs: boolean
  readonly unknown: readonly string[]
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]
const MODELS: readonly ModelTier[] = ["inherit", "flash", "pro"]
const STRICTNESS: readonly GateStrictness[] = ["advisory", "standard", "strict"]
const DEFAULT_EFFORT: Readonly<Record<Role, Effort>> = {
  architect: "high", executor: "high", functional_reviewer: "high",
  security_reviewer: "high", arbiter: "high", operator: "low",
}
// Antigravity exposes model tiers, not arbitrary provider/model identifiers.
const DEFAULT_MODEL: Readonly<Record<Role, ModelTier>> = {
  architect: "pro", executor: "pro", functional_reviewer: "flash",
  security_reviewer: "pro", arbiter: "pro", operator: "flash",
}
const EFFORT_OPTION: Readonly<Record<Role, string>> = {
  architect: "ARCHITECT_EFFORT", executor: "EXECUTOR_EFFORT",
  functional_reviewer: "REVIEWER_EFFORT", security_reviewer: "REVIEWER_EFFORT",
  arbiter: "ARBITER_EFFORT", operator: "OPERATOR_EFFORT",
}
const PREFIXES = ["ANTIGRAVITY_CYCLE_OPTION_", "CYCLE_OPTION_"]

function loadConfigFile(): Record<string, unknown> {
  const paths = [
    join(process.cwd(), ".agents", "cycle.json"),
    join(process.cwd(), ".cycle.json"),
    join(homedir(), ".gemini", "config", "cycle", "config.json"),
  ]
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      return { invalidConfigFile: path }
    }
  }
  return {}
}

export function readConfiguration(environment: NodeJS.ProcessEnv = process.env): Configuration {
  const file = loadConfigFile()
  const invalid: string[] = []
  if (typeof file["invalidConfigFile"] === "string") invalid.push(`the Cycle configuration is not valid JSON: ${file["invalidConfigFile"]}`)
  const fileModels = record(file["models"])
  const fileEfforts = record(file["efforts"])
  const roles = {} as Record<Role, RoleSettings>
  const known = new Set(["DATA_DIR", "GATE_STRICTNESS", "MAX_REPAIR_CYCLES", "SECURITY_PROOFS"])
  for (const role of ROLES) {
    const modelKey = `${role.toUpperCase()}_MODEL`
    known.add(modelKey).add(EFFORT_OPTION[role])
    roles[role] = {
      effort: readEffort(environment, EFFORT_OPTION[role], fileEfforts[role], DEFAULT_EFFORT[role], invalid),
      model: readModel(environment, modelKey, fileModels[role], DEFAULT_MODEL[role], invalid),
    }
  }
  const present = Object.entries(environment).filter(([key]) => PREFIXES.some((prefix) => key.startsWith(prefix)))
  const deliveredEnvironment = present.filter(([, value]) => (value ?? "").trim() !== "").length
  return {
    blank: present.length - deliveredEnvironment,
    dataDirectory: option(environment, "DATA_DIR") || stringValue(file["dataDirectory"]),
    delivered: deliveredEnvironment + Object.keys(fileModels).length + Object.keys(fileEfforts).length,
    gateStrictness: readStrictness(environment, file["gateStrictness"], invalid),
    invalid,
    maxRepairCycles: readRepairCycles(environment, file["maxRepairCycles"], invalid),
    roles,
    securityProofs: readSecurityProofs(environment, file["securityProofs"], invalid),
    unknown: present.map(([key]) => stripPrefix(key)).filter((key) => !known.has(key)).sort(),
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined }
function stripPrefix(key: string): string {
  const prefix = PREFIXES.find((candidate) => key.startsWith(candidate))
  return prefix === undefined ? key : key.slice(prefix.length)
}
function option(environment: NodeJS.ProcessEnv, key: string): string {
  for (const prefix of PREFIXES) {
    const value = environment[`${prefix}${key}`]
    if (value !== undefined && value.trim() !== "") return value.trim()
  }
  return ""
}
function readModel(environment: NodeJS.ProcessEnv, key: string, fileValue: unknown, fallback: ModelTier, invalid: string[]): ModelTier {
  const raw = option(environment, key) || stringValue(fileValue) || ""
  if (!raw) return fallback
  const value = raw.toLowerCase()
  if (!MODELS.includes(value as ModelTier)) {
    invalid.push(`${key} must be one of ${MODELS.join(", ")}; Antigravity accepts model tiers, not provider model IDs`)
    return fallback
  }
  return value as ModelTier
}
function readEffort(environment: NodeJS.ProcessEnv, key: string, fileValue: unknown, fallback: Effort, invalid: string[]): Effort {
  const raw = option(environment, key) || stringValue(fileValue) || ""
  if (!raw) return fallback
  const value = raw.toLowerCase()
  if (!EFFORTS.includes(value as Effort)) { invalid.push(`${key} must be one of ${EFFORTS.join(", ")}`); return fallback }
  return value as Effort
}
function readStrictness(environment: NodeJS.ProcessEnv, fileValue: unknown, invalid: string[]): GateStrictness {
  const value = (option(environment, "GATE_STRICTNESS") || stringValue(fileValue) || "standard").toLowerCase()
  if (!STRICTNESS.includes(value as GateStrictness)) { invalid.push(`GATE_STRICTNESS must be one of ${STRICTNESS.join(", ")}`); return "standard" }
  return value as GateStrictness
}
function readRepairCycles(environment: NodeJS.ProcessEnv, fileValue: unknown, invalid: string[]): number {
  const raw = option(environment, "MAX_REPAIR_CYCLES")
  const value = raw ? Number(raw) : fileValue === undefined ? 5 : Number(fileValue)
  if (!Number.isInteger(value) || value < 1 || value > 20) { invalid.push("MAX_REPAIR_CYCLES must be an integer between 1 and 20"); return 5 }
  return value
}
function readSecurityProofs(environment: NodeJS.ProcessEnv, fileValue: unknown, invalid: string[]): boolean {
  const raw = option(environment, "SECURITY_PROOFS") || (typeof fileValue === "boolean" ? (fileValue ? "on" : "off") : stringValue(fileValue) || "off")
  const value = raw.toLowerCase()
  if (value === "on" || value === "off") return value === "on"
  invalid.push("SECURITY_PROOFS must be on or off; proofs stay off")
  return false
}
