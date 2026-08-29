import { ROLES } from "./config.js";
const MARK = { ok: "ok", warn: "warn", error: "FAIL" };
const BILLED_TO = {
    subscription: "subscription",
};
const ROLE_LABEL = {
    architect: "architect",
    executor: "executor",
    functional_reviewer: "functional reviewer",
    security_reviewer: "security reviewer",
    arbiter: "arbiter",
    operator: "operator",
};
export function renderDoctor(report) {
    const lines = [`Cycle ${report.version} — diagnostics`, ""];
    lines.push("Runtime");
    lines.push(row("node", report.runtime.node));
    lines.push(row("platform", `${report.runtime.platform}/${report.runtime.arch}${report.runtime.wsl ? " (WSL)" : ""}`));
    lines.push(row("git", report.runtime.git ?? "not found"));
    lines.push(row("answering for", `${report.runtime.startedMinutesAgo} min`));
    lines.push(row("package managers", report.runtime.packageManagers
        .map((manager) => `${manager.name}${manager.kind === "shim" ? " (shim)" : ""}`)
        .join(", ") || "none"));
    lines.push("");
    lines.push("Storage");
    lines.push(row("data directory", report.storage.dataDirectory));
    lines.push(row("writable", report.storage.writable ? "yes" : "no"));
    lines.push(row("free disk", bytes(report.storage.availableDiskBytes)));
    lines.push(row("free memory", bytes(report.storage.availableMemoryBytes)));
    lines.push("");
    lines.push("Store");
    lines.push(row("mode", report.store.mode));
    lines.push(row("schema version", report.store.schemaVersion?.toString() ?? "unavailable"));
    lines.push(row("history entries", report.store.historyEntries?.toString() ?? "unavailable"));
    lines.push(row("code graph", report.store.graph === null
        ? "unavailable"
        : `${report.store.graph.files} files · ${report.store.graph.nodes} nodes · ${report.store.graph.edges} edges`));
    lines.push("");
    lines.push("Roles");
    lines.push(columns("role", "model", "effort", "provider", "billed to"));
    for (const role of ROLES) {
        const path = report.models.roles[role];
        const model = path.configured === path.resolved ? path.configured : `${path.configured} → ${path.resolved}`;
        lines.push(columns(ROLE_LABEL[role], model, path.effort, path.provider, BILLED_TO[path.billing]));
    }
    lines.push("");
    lines.push("Model environment");
    lines.push(row("endpoint", report.models.baseUrlHost === null
        ? "default"
        : report.models.baseUrlHost));
    lines.push(row("credential", report.models.credentialMode === "gateway-credential"
        ? "gateway credential (billed per token)"
        : "session default or subscription"));
    lines.push(row("subagent override", report.models.subagentModelOverride ?? "none"));
    lines.push(row("availableModels", report.models.availableModelsAllowlist?.join(", ") ?? "not restricted"));
    lines.push(row("distinct role models", String(report.models.distinctRoleModels)));
    lines.push(row("distinct providers", String(report.models.distinctProviders)));
    lines.push("");
    lines.push("Policy");
    lines.push(row("gate strictness", report.configuration.gateStrictness));
    lines.push(row("repair cycles", String(report.configuration.maxRepairCycles)));
    lines.push(row("options delivered", report.configuration.blank > 0
        ? `${report.configuration.delivered} (${report.configuration.blank} arrived empty)`
        : String(report.configuration.delivered)));
    lines.push("");
    lines.push("Findings");
    for (const finding of report.findings) {
        lines.push(`  [${MARK[finding.severity]}] ${finding.message}`);
    }
    return lines.join("\n");
}
function row(label, value) {
    return `  ${label.padEnd(22)}${value}`;
}
const WIDTHS = [20, 29, 6, 10];
function columns(...cells) {
    const padded = cells.map((cell, index) => index === cells.length - 1 ? cell : `${cell.padEnd(WIDTHS[index] ?? 0)}  `);
    return `  ${padded.join("").trimEnd()}`;
}
function bytes(value) {
    if (value === null)
        return "unknown";
    const gib = value / 1024 ** 3;
    return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2)} MiB`;
}
