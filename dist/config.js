import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const ROLES = ["architect", "executor", "functional_reviewer", "security_reviewer", "arbiter", "operator"];
export const INHERIT = "inherit";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = ["inherit", "flash", "pro"];
const STRICTNESS = ["advisory", "standard", "strict"];
const DEFAULT_EFFORT = {
    architect: "high", executor: "high", functional_reviewer: "high",
    security_reviewer: "high", arbiter: "high", operator: "low",
};
const DEFAULT_MODEL = {
    architect: "pro", executor: "pro", functional_reviewer: "flash",
    security_reviewer: "pro", arbiter: "pro", operator: "flash",
};
const EFFORT_OPTION = {
    architect: "ARCHITECT_EFFORT", executor: "EXECUTOR_EFFORT",
    functional_reviewer: "REVIEWER_EFFORT", security_reviewer: "REVIEWER_EFFORT",
    arbiter: "ARBITER_EFFORT", operator: "OPERATOR_EFFORT",
};
const PREFIXES = ["ANTIGRAVITY_CYCLE_OPTION_", "CYCLE_OPTION_"];
function loadConfigFile() {
    const paths = [
        join(process.cwd(), ".agents", "cycle.json"),
        join(process.cwd(), ".cycle.json"),
        join(homedir(), ".gemini", "config", "cycle", "config.json"),
    ];
    for (const path of paths) {
        if (!existsSync(path))
            continue;
        try {
            const value = JSON.parse(readFileSync(path, "utf8"));
            if (typeof value === "object" && value !== null && !Array.isArray(value))
                return value;
        }
        catch {
            return { invalidConfigFile: path };
        }
    }
    return {};
}
export function readConfiguration(environment = process.env) {
    const file = loadConfigFile();
    const invalid = [];
    if (typeof file["invalidConfigFile"] === "string")
        invalid.push(`the Cycle configuration is not valid JSON: ${file["invalidConfigFile"]}`);
    const fileModels = record(file["models"]);
    const fileEfforts = record(file["efforts"]);
    const roles = {};
    const known = new Set(["DATA_DIR", "GATE_STRICTNESS", "MAX_REPAIR_CYCLES", "SECURITY_PROOFS"]);
    for (const role of ROLES) {
        const modelKey = `${role.toUpperCase()}_MODEL`;
        known.add(modelKey).add(EFFORT_OPTION[role]);
        roles[role] = {
            effort: readEffort(environment, EFFORT_OPTION[role], fileEfforts[role], DEFAULT_EFFORT[role], invalid),
            model: readModel(environment, modelKey, fileModels[role], DEFAULT_MODEL[role], invalid),
        };
    }
    const present = Object.entries(environment).filter(([key]) => PREFIXES.some((prefix) => key.startsWith(prefix)));
    const deliveredEnvironment = present.filter(([, value]) => (value ?? "").trim() !== "").length;
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
    };
}
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function stringValue(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function stripPrefix(key) {
    const prefix = PREFIXES.find((candidate) => key.startsWith(candidate));
    return prefix === undefined ? key : key.slice(prefix.length);
}
function option(environment, key) {
    for (const prefix of PREFIXES) {
        const value = environment[`${prefix}${key}`];
        if (value !== undefined && value.trim() !== "")
            return value.trim();
    }
    return "";
}
function readModel(environment, key, fileValue, fallback, invalid) {
    const raw = option(environment, key) || stringValue(fileValue) || "";
    if (!raw)
        return fallback;
    const value = raw.toLowerCase();
    if (!MODELS.includes(value)) {
        invalid.push(`${key} must be one of ${MODELS.join(", ")}; Antigravity accepts model tiers, not provider model IDs`);
        return fallback;
    }
    return value;
}
function readEffort(environment, key, fileValue, fallback, invalid) {
    const raw = option(environment, key) || stringValue(fileValue) || "";
    if (!raw)
        return fallback;
    const value = raw.toLowerCase();
    if (!EFFORTS.includes(value)) {
        invalid.push(`${key} must be one of ${EFFORTS.join(", ")}`);
        return fallback;
    }
    return value;
}
function readStrictness(environment, fileValue, invalid) {
    const value = (option(environment, "GATE_STRICTNESS") || stringValue(fileValue) || "standard").toLowerCase();
    if (!STRICTNESS.includes(value)) {
        invalid.push(`GATE_STRICTNESS must be one of ${STRICTNESS.join(", ")}`);
        return "standard";
    }
    return value;
}
function readRepairCycles(environment, fileValue, invalid) {
    const raw = option(environment, "MAX_REPAIR_CYCLES");
    const value = raw ? Number(raw) : fileValue === undefined ? 5 : Number(fileValue);
    if (!Number.isInteger(value) || value < 1 || value > 20) {
        invalid.push("MAX_REPAIR_CYCLES must be an integer between 1 and 20");
        return 5;
    }
    return value;
}
function readSecurityProofs(environment, fileValue, invalid) {
    const raw = option(environment, "SECURITY_PROOFS") || (typeof fileValue === "boolean" ? (fileValue ? "on" : "off") : stringValue(fileValue) || "off");
    const value = raw.toLowerCase();
    if (value === "on" || value === "off")
        return value === "on";
    invalid.push("SECURITY_PROOFS must be on or off; proofs stay off");
    return false;
}
