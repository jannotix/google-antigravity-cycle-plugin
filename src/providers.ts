import { INHERIT, ROLES, type Configuration, type Effort, type Role } from "./config.ts"
export type Billing = "subscription"
export interface RoleProvider { readonly billing: Billing; readonly configured: string; readonly effort: Effort; readonly provider: string; readonly resolved: string }
export interface ProviderPaths {
  readonly credentialMode: "subscription-or-default"; readonly credentialVariable: null
  readonly distinctProviders: number; readonly endpoint: null; readonly gateway: false
  readonly roles: Readonly<Record<Role, RoleProvider>>; readonly unroutable: readonly string[]
}
export function describeProviders(configuration: Configuration, _environment?: NodeJS.ProcessEnv): ProviderPaths {
  const roles = {} as Record<Role, RoleProvider>
  for (const role of ROLES) {
    const { effort, model } = configuration.roles[role]
    roles[role] = { billing: "subscription", configured: model, effort, provider: "antigravity", resolved: model === INHERIT ? "session model" : `${model} tier` }
  }
  return { credentialMode: "subscription-or-default", credentialVariable: null, distinctProviders: 1, endpoint: null, gateway: false, roles, unroutable: [] }
}
