import { INHERIT } from "./config.js";
export const ROLE_AGENT = {
    architect: "architect", executor: "executor", functional_reviewer: "functional-reviewer",
    security_reviewer: "security-reviewer", arbiter: "arbiter", operator: "operator",
};
export const CONSULTATION = {
    architect: "architect", executor: "executor", judge: "arbiter", review: "functional_reviewer", security: "security_reviewer",
};
const CONSULTATION_AGENT = { executor: "executor-advisor" };
export function subagentModelFor(model) {
    if (model === null || model === INHERIT)
        return null;
    return model === "flash" || model === "pro" ? model : null;
}
export function resolveRole(configuration, role) {
    const configured = configuration.roles[role];
    const inherits = configured.model === INHERIT;
    const model = inherits ? null : configured.model;
    return { agent: ROLE_AGENT[role], effort: configured.effort, inherits, model, role, subagentModel: subagentModelFor(model) };
}
export function resolveConsultation(configuration, consultation) {
    const role = CONSULTATION[consultation];
    if (role === undefined)
        throw new Error(`unknown consultation: ${consultation}`);
    const resolved = resolveRole(configuration, role);
    return { ...resolved, agent: CONSULTATION_AGENT[consultation] ?? resolved.agent };
}
const READ_ONLY_TOOLS = ["write_to_file", "replace_file_content", "multi_replace_file_content", "run_command", "invoke_subagent", "define_subagent"];
export const BOUNDARIES = [
    { cannot: READ_ONLY_TOOLS, may: "inspect the repository and produce a plan", role: "architect", writes: false },
    { cannot: ["invoke_subagent", "define_subagent"], may: "modify only assigned scopes and run verification; publication needs user approval", role: "executor", writes: true },
    { cannot: READ_ONLY_TOOLS, may: "review the frozen candidate and report findings", role: "functional_reviewer", writes: false },
    { cannot: READ_ONLY_TOOLS, may: "review security and request controlled proofs through the control plane", role: "security_reviewer", writes: false },
    { cannot: READ_ONLY_TOOLS, may: "judge the candidate; delivery still requires passed gates", role: "arbiter", writes: false },
    { cannot: READ_ONLY_TOOLS, may: "relay deterministic control-plane calls only", role: "operator", writes: false },
];
