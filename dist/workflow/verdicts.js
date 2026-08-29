export class VerdictRejected extends Error {
    constructor(message) {
        super(message);
        this.name = "VerdictRejected";
    }
}
const MAX_ITEMS = 256;
const MAX_SUMMARY = 4_096;
const MAX_IDENTIFIER = 64;
const SEVERITIES = ["critical", "high", "info", "low", "medium"];
export function parseVerdict(raw, context) {
    const root = exactKeys(raw, ["decision", "findings", "repair_target", "requirements"], context.role);
    const decision = root["decision"];
    if (decision !== "approved" && decision !== "rejected") {
        throw new VerdictRejected(`${context.role} decision must be approved or rejected`);
    }
    const repairTarget = root["repair_target"];
    if (repairTarget !== null && repairTarget !== "architecture" && repairTarget !== "execution") {
        throw new VerdictRejected(`${context.role} repair_target must be null, architecture or execution`);
    }
    const requirements = boundedArray(root["requirements"], "requirements", context.role, true).map((entry) => parseRequirement(entry, context));
    const findings = boundedArray(root["findings"], "findings", context.role, true).map((entry) => parseFinding(entry, context));
    assertEveryRequirementDecidedOnce(requirements, context);
    if (decision === "rejected" && repairTarget === null) {
        throw new VerdictRejected(`${context.role} rejected without naming a repair target`);
    }
    if (decision === "approved" && repairTarget !== null) {
        throw new VerdictRejected(`${context.role} approved while naming a repair target`);
    }
    if (decision === "approved" && requirements.some((entry) => entry.status === "unsatisfied")) {
        throw new VerdictRejected(`${context.role} approved with an unsatisfied requirement`);
    }
    if (decision === "approved" &&
        findings.some((finding) => finding.severity === "critical" || finding.severity === "high")) {
        throw new VerdictRejected(`${context.role} approved with an unresolved critical or high finding`);
    }
    return { decision, findings, repairTarget, requirements };
}
function parseRequirement(raw, context) {
    const entry = exactKeys(raw, ["evidence_ids", "requirement_id", "status"], context.role);
    const status = entry["status"];
    if (status !== "satisfied" && status !== "unsatisfied") {
        throw new VerdictRejected(`${context.role} requirement status must be satisfied or unsatisfied`);
    }
    const requirementId = text(entry["requirement_id"], "requirement_id", MAX_IDENTIFIER, context.role);
    if (!context.requirementIds.includes(requirementId)) {
        throw new VerdictRejected(`${context.role} decided requirement ${requirementId}, which is not in the plan`);
    }
    return {
        evidenceIds: citedEvidence(entry["evidence_ids"], context),
        requirementId,
        status,
    };
}
function parseFinding(raw, context) {
    const entry = exactKeys(raw, ["evidence_ids", "severity", "summary"], context.role);
    const severity = entry["severity"];
    if (typeof severity !== "string" || !SEVERITIES.includes(severity)) {
        throw new VerdictRejected(`${context.role} finding severity must be one of ${SEVERITIES.join(", ")}`);
    }
    const evidenceIds = citedEvidence(entry["evidence_ids"], context);
    const summary = text(entry["summary"], "finding summary", MAX_SUMMARY, context.role);
    if (unproven(severity, evidenceIds, context)) {
        return { evidenceIds, severity: "info", summary: `unproven: ${summary}` };
    }
    return { evidenceIds, severity: severity, summary };
}
function unproven(severity, evidenceIds, context) {
    if (context.requiresProof !== true)
        return false;
    if (severity !== "critical" && severity !== "high")
        return false;
    const proofs = new Set(context.proofIds ?? []);
    return !evidenceIds.some((id) => proofs.has(id));
}
function assertEveryRequirementDecidedOnce(requirements, context) {
    const decided = requirements.map((entry) => entry.requirementId);
    const unique = new Set(decided);
    if (unique.size !== decided.length) {
        throw new VerdictRejected(`${context.role} decided the same requirement more than once`);
    }
    const missing = context.requirementIds.filter((id) => !unique.has(id));
    if (missing.length > 0) {
        throw new VerdictRejected(`${context.role} did not decide: ${missing.join(", ")}`);
    }
}
function citedEvidence(raw, context) {
    if (!Array.isArray(raw) || raw.length > MAX_ITEMS) {
        throw new VerdictRejected(`${context.role} evidence_ids must be a bounded array`);
    }
    const ids = raw.map((entry) => {
        if (typeof entry !== "string") {
            throw new VerdictRejected(`${context.role} evidence identifiers must be strings`);
        }
        if (!context.evidenceIds.includes(entry)) {
            throw new VerdictRejected(`${context.role} cited evidence ${entry}, which was not supplied`);
        }
        return entry;
    });
    return ids;
}
function exactKeys(raw, keys, role) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new VerdictRejected(`${role} result must be a JSON object`);
    }
    const actual = Object.keys(raw).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new VerdictRejected(`${role} result must have exactly these keys: ${expected.join(", ")} (received: ${actual.join(", ") || "none"})`);
    }
    return raw;
}
function boundedArray(raw, field, role, allowEmpty) {
    if (!Array.isArray(raw) || raw.length > MAX_ITEMS || (!allowEmpty && raw.length === 0)) {
        throw new VerdictRejected(`${role} ${field} must be an array of ${allowEmpty ? "at most" : "one to"} ${MAX_ITEMS} items`);
    }
    return raw;
}
function text(raw, field, maximum, role) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > maximum) {
        throw new VerdictRejected(`${role} ${field} must be non-empty text of at most ${maximum} characters`);
    }
    return raw.trim();
}
