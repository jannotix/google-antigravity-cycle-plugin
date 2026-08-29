import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeInvocation, parseCommand, UnsafeCommand } from "../workflow/commands.js";
import { DEFAULT_TIMEOUT_SECONDS } from "./gates.js";
const NODE_SCRIPTS = {
    build: "build",
    check: "test",
    e2e: "test",
    lint: "lint",
    test: "test",
    "test:integration": "test",
    "test:unit": "test",
    typecheck: "lint",
    "type-check": "lint",
};
const LOCKFILES = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
];
const RUST_GATES = [
    ["lint", "cargo fmt --check"],
    ["lint", "cargo clippy --all-targets --all-features -- -D warnings"],
    ["test", "cargo test --all-features"],
];
const PYTHON_GATES = [
    ["test", "pytest"],
    ["lint", "ruff check ."],
    ["lint", "mypy ."],
];
const GO_GATES = [
    ["build", "go build ./..."],
    ["lint", "go vet ./..."],
    ["test", "go test ./..."],
];
const MAKE_TARGETS = {
    build: "build",
    check: "test",
    lint: "lint",
    test: "test",
    verify: "test",
};
export async function discoverGates(root, taskCommands) {
    const gates = new Map();
    const ecosystems = [];
    const add = (kind, text, precondition) => {
        let command;
        try {
            command = parseCommand(text);
        }
        catch (error) {
            if (error instanceof UnsafeCommand)
                return;
            throw error;
        }
        const key = normalizeInvocation(command);
        if (gates.has(key))
            return;
        const invocation = [command.program, ...command.arguments].join(" ");
        gates.set(key, {
            executor: { command, kind: "command" },
            invocation,
            kind,
            mandatory: true,
            name: `${kind}:${invocation}`,
            precondition,
            timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        });
    };
    for (const command of taskCommands) {
        add("command", command, "the architect declared this command for a task in this change");
    }
    const manifest = await readJson(join(root, "package.json"));
    const packageManager = manifest === null ? null : await detectPackageManager(root);
    if (manifest !== null) {
        ecosystems.push("node");
        const scripts = (manifest["scripts"] ?? {});
        for (const [script, kind] of Object.entries(NODE_SCRIPTS)) {
            if (typeof scripts[script] !== "string")
                continue;
            add(kind, `${packageManager} run ${script}`, `package.json declares the ${script} script`);
        }
    }
    if (await exists(join(root, "Cargo.toml"))) {
        ecosystems.push("rust");
        for (const [kind, text] of RUST_GATES)
            add(kind, text, "the project is a Cargo workspace");
    }
    if ((await exists(join(root, "pyproject.toml"))) || (await exists(join(root, "tox.ini")))) {
        ecosystems.push("python");
        for (const [kind, text] of PYTHON_GATES)
            add(kind, text, "the project declares a Python build");
    }
    if (await exists(join(root, "go.mod"))) {
        ecosystems.push("go");
        for (const [kind, text] of GO_GATES)
            add(kind, text, "the project declares a Go module");
    }
    const targets = await makeTargets(root);
    if (targets.length > 0) {
        ecosystems.push("make");
        for (const target of targets) {
            add(MAKE_TARGETS[target], `make ${target}`, `the Makefile declares the ${target} target`);
        }
    }
    return { ecosystems, gates: [...gates.values()], packageManager };
}
export async function detectPackageManager(root) {
    for (const [lockfile, manager] of LOCKFILES) {
        if (await exists(join(root, lockfile)))
            return manager;
    }
    return "npm";
}
async function makeTargets(root) {
    const content = await readText(join(root, "Makefile"));
    if (content === null)
        return [];
    const found = new Set();
    for (const line of content.split(/\r?\n/u)) {
        const match = /^([A-Za-z0-9_.-]+)\s*:(?!=)/u.exec(line);
        const target = match?.[1];
        if (target !== undefined && target in MAKE_TARGETS)
            found.add(target);
    }
    return [...found].sort();
}
async function readJson(path) {
    const content = await readText(path);
    if (content === null)
        return null;
    try {
        const parsed = JSON.parse(content);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
async function readText(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch {
        return null;
    }
}
async function exists(path) {
    try {
        return (await stat(path)).isFile();
    }
    catch {
        return false;
    }
}
