import { INHERIT, ROLES, type Configuration, type Effort, type Role } from "./config.ts"

const JUDGING: readonly Role[] = [
  "architect",
  "executor",
  "functional_reviewer",
  "security_reviewer",
  "arbiter",
]

export type Billing = "subscription" | "direct-api" | "gateway-credential" | "local-endpoint"

export interface RoleProvider {
  readonly billing: Billing
  readonly configured: string
  readonly effort: Effort
  readonly provider: string
  readonly resolved: string
}

export interface ProviderPaths {
  readonly credentialMode: "direct-or-local" | "subscription-or-default"
  readonly credentialVariable: string | null
  readonly distinctProviders: number
  readonly endpoint: string | null
  readonly gateway: boolean
  readonly roles: Readonly<Record<Role, RoleProvider>>
  readonly unroutable: readonly string[]
}

export function describeProviders(
  configuration: Configuration,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderPaths {
  const endpoint = hostOf(environment["CYCLE_BASE_URL"] || environment["OPENAI_BASE_URL"] || environment["ANTHROPIC_BASE_URL"])
  const gateway = endpoint !== null
  const credentialVariable = credential(environment)

  const roles = {} as Record<Role, RoleProvider>
  for (const role of ROLES) {
    const { effort, model } = configuration.roles[role]
    const provider = providerOf(model, gateway)
    roles[role] = {
      billing: billingOf(provider, credentialVariable !== null, gateway),
      configured: model,
      effort,
      provider,
      resolved: model === INHERIT ? "session model" : model,
    }
  }

  return {
    credentialMode: credentialVariable === null ? "subscription-or-default" : "direct-or-local",
    credentialVariable,
    distinctProviders: new Set(JUDGING.map((role) => roles[role].provider)).size,
    endpoint,
    gateway,
    roles,
    unroutable: [],
  }
}

function providerOf(model: string, gateway: boolean): string {
  if (model === INHERIT) return "session"
  const lower = model.toLowerCase()
  if (lower.startsWith("gemini")) return "google"
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("openai/")) return "openai"
  if (lower.startsWith("qwen") || lower.startsWith("dashscope/")) return "qwen"
  if (lower.startsWith("glm") || lower.startsWith("zhipu/")) return "glm"
  if (lower.startsWith("deepseek") || lower.startsWith("deepseek/")) return "deepseek"
  if (lower.startsWith("claude") || lower.startsWith("anthropic/")) return "anthropic"
  if (lower.startsWith("ollama") || lower.startsWith("local/")) return "local"
  if (prefixed(model)) return model.slice(0, model.indexOf("/")).toLowerCase()
  return gateway ? "gateway" : "custom"
}

function billingOf(provider: string, credentialSet: boolean, gateway: boolean): Billing {
  if (provider === "local") return "local-endpoint"
  if (credentialSet) return "direct-api"
  if (provider === "session") return "subscription"
  if (gateway) return "gateway-credential"
  return "subscription"
}

function prefixed(model: string): boolean {
  const slash = model.indexOf("/")
  return slash > 0 && slash < model.length - 1
}

function credential(environment: NodeJS.ProcessEnv): string | null {
  for (const key of [
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "QWEN_API_KEY",
    "GLM_API_KEY",
    "DEEPSEEK_API_KEY",
    "ANTHROPIC_API_KEY",
    "CYCLE_API_KEY",
  ]) {
    if (environment[key]?.trim()) return key
  }
  return null
}

function hostOf(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    return new URL(raw).host
  } catch {
    return raw.slice(0, 64)
  }
}
