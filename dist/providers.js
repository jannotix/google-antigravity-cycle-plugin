import { INHERIT, ROLES } from "./config.js";
export function describeProviders(configuration, _environment) {
    const roles = {};
    for (const role of ROLES) {
        const { effort, model } = configuration.roles[role];
        roles[role] = { billing: "subscription", configured: model, effort, provider: "antigravity", resolved: model === INHERIT ? "session model" : `${model} tier` };
    }
    return { credentialMode: "subscription-or-default", credentialVariable: null, distinctProviders: 1, endpoint: null, gateway: false, roles, unroutable: [] };
}
