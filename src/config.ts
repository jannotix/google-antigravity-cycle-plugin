import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export type Role =
  | "architect"
  | "executor"
  | "functional_reviewer"
  | "security_reviewer"
  | "arbiter"
  | "operator"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export type GateStrictness = "advisory" | "standard" | "strict"

export const ROLES: readonly Role[] = [
  "architect",
  "executor",
  "functional_reviewer",
  "security_reviewer",
  "arbiter",
  "operator",
]

export const INHERIT = "inherit"

export interface RoleSettings {
  readonly effort: Effort
  readonly model: string
}

export interface Configuration {
  readonly dataDirectory: string | undefined
  readonly gateStrictness: GateStrictness
  readonly invalid: readonly string[]
  readonly maxRepairCycles: number
  readonly roles: Readonly<Record<Role, RoleSettings>>
  readonly credentialsFile: string | undefined
  readonly unknown: readonly string[]
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]
const STRICTNESS: readonly GateStrictness[] = ["advisory", "standard", "strict"]

const DEFAULT_EFFORT: Readonly<Record<Role, Effort>> = {
  architect: "high",
  executor: "high",
  functional_reviewer: "high",
  security_reviewer: "high",
  arbiter: "high",
  operator: "low",
}

const DEFAULT_MODEL: Readonly<Record<Role, string>> = {
  architect: INHERIT,
  executor: INHERIT,
  functional_reviewer: INHERIT,
  security_reviewer: INHERIT,
  arbiter: INHERIT,
  operator: INHERIT,
}

const EFFORT_OPTION: Readonly<Record<Role, string>> = {
  architect: "ARCHITECT_EFFORT",
  executor: "EXECUTOR_EFFORT",
  functional_reviewer: "REVIEWER_EFFORT",
  security_reviewer: "REVIEWER_EFFORT",
  arbiter: "ARBITER_EFFORT",
  operator: "OPERATOR_EFFORT",
}

const PREFIXES = ["ANTIGRAVITY_CYCLE_OPTION_", "CYCLE_OPTION_", "CLAUDE_PLUGIN_OPTION_"]

function loadConfigFile(): Record<string, unknown> {
  const paths = [
    join(process.cwd(), ".agents", "cycle.json"),
    join(process.cwd(), ".cycle.json"),
    join(homedir(), ".gemini", "config", "cycle", "config.json"),
  ]
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"))
      } catch {}
    }
  }
  return {}
}

export function readConfiguration(environment: NodeJS.ProcessEnv = process.env): Configuration {
  const fileConfig = loadConfigFile()
  const invalid: string[] = []
  const roles = {} as Record<Role, RoleSettings>
  const known = new Set(["DATA_DIR", "GATE_STRICTNESS", "MAX_REPAIR_CYCLES", "CREDENTIALS_FILE"])

  const fileModels = (fileConfig.models as Record<string, string> | undefined) ?? {}
  const fileEfforts = (fileConfig.efforts as Record<string, Effort> | undefined) ?? {}

  for (const role of ROLES) {
    const modelKey = `${role.toUpperCase()}_MODEL`
    known.add(modelKey).add(EFFORT_OPTION[role])
    const defaultEffort = fileEfforts[role] ?? DEFAULT_EFFORT[role]
    const defaultModel = fileModels[role] ?? DEFAULT_MODEL[role]
    roles[role] = {
      effort: readEffort(environment, EFFORT_OPTION[role], defaultEffort, invalid),
      model: readModel(environment, modelKey, defaultModel, invalid),
    }
  }

  return {
    dataDirectory: option(environment, "DATA_DIR") || undefined,
    gateStrictness: readStrictness(environment, invalid, fileConfig.gateStrictness as GateStrictness | undefined),
    invalid,
    maxRepairCycles: readRepairCycles(environment, invalid, fileConfig.maxRepairCycles as number | undefined),
    roles,
    credentialsFile: option(environment, "CREDENTIALS_FILE") || undefined,
    unknown: Object.keys(environment)
      .filter((key) => PREFIXES.some((p) => key.startsWith(p)) && !known.has(stripPrefix(key)))
      .map((key) => stripPrefix(key))
      .sort(),
  }
}

function stripPrefix(key: string): string {
  for (const prefix of PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length)
  }
  return key
}

function option(environment: NodeJS.ProcessEnv, key: string): string {
  for (const prefix of PREFIXES) {
    const val = environment[`${prefix}${key}`]
    if (val !== undefined && val.trim() !== "") return val.trim()
  }
  return ""
}

function readModel(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
  invalid: string[],
): string {
  const value = option(environment, key)
  if (!value) return fallback
  if (value.length > 128 || /\s/u.test(value)) {
    invalid.push(`${key} is not a valid model identifier`)
    return fallback
  }
  return value
}

function readEffort(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: Effort,
  invalid: string[],
): Effort {
  const value = option(environment, key).toLowerCase()
  if (!value) return fallback
  if (!EFFORTS.includes(value as Effort)) {
    invalid.push(`${key} must be one of ${EFFORTS.join(", ")}`)
    return fallback
  }
  return value as Effort
}

function readStrictness(environment: NodeJS.ProcessEnv, invalid: string[], fileFallback?: GateStrictness): GateStrictness {
  const value = option(environment, "GATE_STRICTNESS").toLowerCase()
  if (!value) return fileFallback && STRICTNESS.includes(fileFallback) ? fileFallback : "standard"
  if (!STRICTNESS.includes(value as GateStrictness)) {
    invalid.push(`GATE_STRICTNESS must be one of ${STRICTNESS.join(", ")}`)
    return "standard"
  }
  return value as GateStrictness
}

function readRepairCycles(environment: NodeJS.ProcessEnv, invalid: string[], fileFallback?: number): number {
  const value = option(environment, "MAX_REPAIR_CYCLES")
  if (!value) return typeof fileFallback === "number" && fileFallback >= 1 && fileFallback <= 20 ? fileFallback : 5
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    invalid.push("MAX_REPAIR_CYCLES must be an integer between 1 and 20")
    return 5
  }
  return parsed
}
