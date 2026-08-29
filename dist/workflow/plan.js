import { parseCommand, UnsafeCommand } from "./commands.js";
import { normalizeScope, scopesOverlap } from "./scopes.js";
export class PlanRejected extends Error {
    constructor(message) {
        super(message);
        this.name = "PlanRejected";
    }
}
const MAX_ITEMS = 256;
const MAX_TEXT = 4_096;
const MAX_ID = 64;
export function parsePlan(raw) {
    const root = exactKeys(raw, [
        "assumptions",
        "integration_checks",
        "requirements",
        "risks",
        "tasks",
    ]);
    const requirements = list(root["requirements"], "requirements", false).map(parseRequirement);
    const tasks = list(root["tasks"], "tasks", false).map(parseTask);
    assertUnique(requirements.map((entry) => entry.id), "requirement id");
    assertUnique(tasks.map((entry) => entry.key), "task key");
    assertRequirementsCovered(requirements, tasks);
    assertDependenciesResolve(tasks);
    assertAcyclic(tasks);
    assertScopesOrdered(tasks);
    return {
        assumptions: strings(root["assumptions"], "assumptions"),
        integrationChecks: strings(root["integration_checks"], "integration_checks"),
        requirements,
        risks: strings(root["risks"], "risks"),
        tasks,
    };
}
function parseRequirement(raw) {
    const entry = exactKeys(raw, ["acceptance_criteria", "id", "statement"]);
    return {
        acceptanceCriteria: strings(entry["acceptance_criteria"], "acceptance_criteria", false),
        id: text(entry["id"], "requirement id", MAX_ID),
        statement: text(entry["statement"], "requirement statement", MAX_TEXT),
    };
}
function parseTask(raw) {
    const entry = exactKeys(raw, [
        "acceptance_criteria",
        "dependencies",
        "key",
        "objective",
        "requirement_ids",
        "title",
        "verification_commands",
        "write_scopes",
    ]);
    const writeScopes = strings(entry["write_scopes"], "write_scopes", false);
    for (const scope of writeScopes)
        assertProjectRelative(scope);
    const verificationCommands = strings(entry["verification_commands"], "verification_commands", false);
    for (const command of verificationCommands) {
        try {
            parseCommand(command);
        }
        catch (error) {
            if (error instanceof UnsafeCommand)
                throw new PlanRejected(error.message);
            throw error;
        }
    }
    return {
        acceptanceCriteria: strings(entry["acceptance_criteria"], "acceptance_criteria", false),
        dependencies: strings(entry["dependencies"], "dependencies"),
        key: text(entry["key"], "task key", MAX_ID),
        objective: text(entry["objective"], "task objective", MAX_TEXT),
        requirementIds: strings(entry["requirement_ids"], "requirement_ids", false),
        title: text(entry["title"], "task title", MAX_TEXT),
        verificationCommands,
        writeScopes,
    };
}
function assertRequirementsCovered(requirements, tasks) {
    const known = new Set(requirements.map((entry) => entry.id));
    const covered = new Set(tasks.flatMap((task) => task.requirementIds));
    const unknown = [...covered].filter((id) => !known.has(id));
    if (unknown.length > 0) {
        throw new PlanRejected(`tasks reference requirements that do not exist: ${unknown.join(", ")}`);
    }
    const orphaned = [...known].filter((id) => !covered.has(id));
    if (orphaned.length > 0) {
        throw new PlanRejected(`no task implements: ${orphaned.join(", ")}`);
    }
}
function assertDependenciesResolve(tasks) {
    const keys = new Set(tasks.map((task) => task.key));
    for (const task of tasks) {
        for (const dependency of task.dependencies) {
            if (dependency === task.key)
                throw new PlanRejected(`task ${task.key} depends on itself`);
            if (!keys.has(dependency)) {
                throw new PlanRejected(`task ${task.key} depends on unknown task ${dependency}`);
            }
        }
    }
}
function assertAcyclic(tasks) {
    const pending = new Map(tasks.map((task) => [task.key, task]));
    const done = new Set();
    while (pending.size > 0) {
        const ready = [...pending.values()].filter((task) => task.dependencies.every((dependency) => done.has(dependency)));
        if (ready.length === 0) {
            throw new PlanRejected(`task dependencies form a cycle: ${[...pending.keys()].join(", ")}`);
        }
        for (const task of ready) {
            done.add(task.key);
            pending.delete(task.key);
        }
    }
}
function assertScopesOrdered(tasks) {
    const reachable = transitiveDependencies(tasks);
    for (const left of tasks) {
        for (const right of tasks) {
            if (left.key >= right.key)
                continue;
            if (!scopesOverlap(left.writeScopes, right.writeScopes))
                continue;
            if (!reachable.get(left.key)?.has(right.key) &&
                !reachable.get(right.key)?.has(left.key)) {
                throw new PlanRejected(`tasks ${left.key} and ${right.key} write overlapping scopes without an ordering between them`);
            }
        }
    }
}
function transitiveDependencies(tasks) {
    const direct = new Map(tasks.map((task) => [task.key, task.dependencies]));
    const result = new Map();
    const resolve = (key, seen) => {
        const cached = result.get(key);
        if (cached !== undefined)
            return cached;
        const all = new Set();
        for (const dependency of direct.get(key) ?? []) {
            if (seen.has(dependency))
                continue;
            all.add(dependency);
            for (const nested of resolve(dependency, new Set([...seen, dependency])))
                all.add(nested);
        }
        result.set(key, all);
        return all;
    };
    for (const task of tasks)
        resolve(task.key, new Set([task.key]));
    return result;
}
function assertProjectRelative(scope) {
    const normalized = normalizeScope(scope);
    if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)) {
        throw new PlanRejected(`write scope must be project-relative: ${scope}`);
    }
    if (normalized.split("/").includes("..")) {
        throw new PlanRejected(`write scope must stay inside the project: ${scope}`);
    }
}
function assertUnique(values, label) {
    if (new Set(values).size !== values.length) {
        throw new PlanRejected(`duplicate ${label} in the plan`);
    }
}
function exactKeys(raw, keys) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new PlanRejected("plan section must be a JSON object");
    }
    const actual = Object.keys(raw).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new PlanRejected(`plan section must have exactly these keys: ${expected.join(", ")} (received: ${actual.join(", ") || "none"})`);
    }
    return raw;
}
function list(raw, field, allowEmpty) {
    if (!Array.isArray(raw) || raw.length > MAX_ITEMS || (!allowEmpty && raw.length === 0)) {
        throw new PlanRejected(`${field} must be an array of 1 to ${MAX_ITEMS} items`);
    }
    return raw;
}
function strings(raw, field, allowEmpty = true) {
    const items = list(raw, field, allowEmpty);
    return items.map((entry) => text(entry, `${field} entry`, MAX_TEXT));
}
function text(raw, field, maximum) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > maximum) {
        throw new PlanRejected(`${field} must be non-empty text of at most ${maximum} characters`);
    }
    return raw.trim();
}
