import { INHERIT, type Configuration, type Effort, type ModelTier, type Role } from "./config.ts"

export const ROLE_AGENT: Readonly<Record<Role, string>> = {
  architect: "architect", executor: "executor", functional_reviewer: "functional-reviewer",
  security_reviewer: "security-reviewer", arbiter: "arbiter", operator: "operator",
}
export const CONSULTATION: Readonly<Record<string, Role>> = {
  architect: "architect", executor: "executor", judge: "arbiter", review: "functional_reviewer", security: "security_reviewer",
}
const CONSULTATION_AGENT: Readonly<Record<string, string>> = { executor: "executor-advisor" }
export interface ResolvedRole {
  readonly agent: string; readonly effort: Effort; readonly inherits: boolean
  readonly model: ModelTier | null; readonly role: Role; readonly subagentModel: ModelTier | null
}
export function subagentModelFor(model: string | null): ModelTier | null {
  if (model === null || model === INHERIT) return null
  return model === "flash" || model === "pro" ? model : null
}
export function resolveRole(configuration: Configuration, role: Role): ResolvedRole {
  const configured = configuration.roles[role]
  const inherits = configured.model === INHERIT
  const model = inherits ? null : configured.model
  return { agent: ROLE_AGENT[role], effort: configured.effort, inherits, model, role, subagentModel: subagentModelFor(model) }
}
export function resolveConsultation(configuration: Configuration, consultation: string): ResolvedRole {
  const role = CONSULTATION[consultation]
  if (role === undefined) throw new Error(`unknown consultation: ${consultation}`)
  const resolved = resolveRole(configuration, role)
  return { ...resolved, agent: CONSULTATION_AGENT[consultation] ?? resolved.agent }
}
export interface RoleBoundary { readonly cannot: readonly string[]; readonly may: string; readonly role: Role; readonly writes: boolean }
const READ_ONLY_TOOLS: readonly string[] = ["write_to_file", "replace_file_content", "multi_replace_file_content", "run_command", "invoke_subagent", "define_subagent"]
export const BOUNDARIES: readonly RoleBoundary[] = [
  { cannot: READ_ONLY_TOOLS, may: "inspect the repository and produce a plan", role: "architect", writes: false },
  { cannot: ["invoke_subagent", "define_subagent"], may: "modify only assigned scopes and run verification; publication needs user approval", role: "executor", writes: true },
  { cannot: READ_ONLY_TOOLS, may: "review the frozen candidate and report findings", role: "functional_reviewer", writes: false },
  { cannot: READ_ONLY_TOOLS, may: "review security and request controlled proofs through the control plane", role: "security_reviewer", writes: false },
  { cannot: READ_ONLY_TOOLS, may: "judge the candidate; delivery still requires passed gates", role: "arbiter", writes: false },
  { cannot: READ_ONLY_TOOLS, may: "relay deterministic control-plane calls only", role: "operator", writes: false },
]
