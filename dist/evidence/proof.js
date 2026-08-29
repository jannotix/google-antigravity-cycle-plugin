import { execFile } from "node:child_process";
import { mkdtemp, mkdir, copyFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "../secrets.js";
import { parseCommand, UnsafeCommand } from "../workflow/commands.js";
import { runCommand } from "./runner.js";
import { gitArgs } from "../git.js";
const execFileAsync = promisify(execFile);
export const PROOF_TIMEOUT_SECONDS = 60;
const MAX_COPIED_FILES = 5_000;
const MAX_COPIED_BYTES = 64 * 1_024 * 1_024;
const GIT_TIMEOUT_MS = 30_000;
const REFUSED_ARGUMENTS = new Set([
    "add",
    "curl",
    "download",
    "fetch",
    "install",
    "link",
    "publish",
    "release",
    "remove",
    "uninstall",
    "upgrade",
    "upload",
    "wget",
]);
const REFUSED_PROGRAMS = new Set(["curl", "docker", "kubectl", "nc", "ncat", "scp", "ssh", "wget"]);
export class ProofRefused extends Error {
    constructor(message) {
        super(message);
        this.name = "ProofRefused";
    }
}
const INTERPRETERS = {
    node: "mjs",
    perl: "pl",
    php: "php",
    python: "py",
    python3: "py",
    ruby: "rb",
};
const PROOF_DIRECTORY = ".cycle-proof";
const MAX_SCRIPT_BYTES = 64 * 1_024;
export function assertProofSafe(command) {
    const program = command.program
        .replaceAll("\\", "/")
        .split("/")
        .pop()
        .replace(/\.(exe|cmd|bat|ps1)$/iu, "")
        .toLowerCase();
    if (REFUSED_PROGRAMS.has(program)) {
        throw new ProofRefused(`${program} cannot run inside a proof: a proof has no network and installs nothing`);
    }
    for (const argument of command.arguments) {
        if (REFUSED_ARGUMENTS.has(argument.toLowerCase())) {
            throw new ProofRefused(`${argument} is not permitted in a proof: it installs, fetches or publishes`);
        }
    }
}
export async function runProof(root, request) {
    const interpreter = (request.interpreter ?? "node").toLowerCase();
    const extension = INTERPRETERS[interpreter];
    const script = request.script ?? "";
    if (script && extension === undefined) {
        throw new ProofRefused(`${interpreter} is not a proof interpreter; choose one of ${Object.keys(INTERPRETERS).join(", ")}`);
    }
    if (script.length > MAX_SCRIPT_BYTES) {
        throw new ProofRefused(`a proof script is at most ${MAX_SCRIPT_BYTES} bytes`);
    }
    const scriptPath = `${PROOF_DIRECTORY}/proof.${extension ?? "txt"}`;
    const commandText = request.command ?? (script ? `${interpreter} ${scriptPath}` : "");
    if (!commandText.trim()) {
        throw new ProofRefused("a proof needs a script to run, or a command to run against the copy");
    }
    let command;
    try {
        command = parseCommand(commandText);
    }
    catch (error) {
        throw new ProofRefused(error instanceof UnsafeCommand ? error.message : String(error));
    }
    assertProofSafe(command);
    const workspace = await mkdtemp(join(tmpdir(), "cycle-proof-"));
    try {
        const copied = await copyCandidate(root, workspace);
        if (script) {
            await mkdir(join(workspace, PROOF_DIRECTORY), { recursive: true });
            await writeFile(join(workspace, scriptPath), script, "utf8");
        }
        const outcome = await runCommand(command, {
            cwd: workspace,
            environment: containedEnvironment(),
            timeoutSeconds: PROOF_TIMEOUT_SECONDS,
        });
        return {
            containment: [
                `disposable copy of ${copied} files, deleted after the run`,
                "environment reduced to the variables an interpreter needs to start",
                "output redacted for secret shapes before it is recorded or returned",
                script ? `proof script written to ${scriptPath} inside the copy only` : "no script written",
                `hard timeout of ${PROOF_TIMEOUT_SECONDS}s`,
                "http and https proxied to a closed loopback port; localhost excluded",
                "package installation, download and publication arguments refused",
                "no shell: program and argument vector only",
            ],
            demonstrated: outcome.unavailable === null && outcome.exitCode === 0,
            outcome: { ...outcome, output: redactSecrets(outcome.output) },
        };
    }
    finally {
        await rm(workspace, { force: true, recursive: true });
    }
}
const PASSED_THROUGH = new Set([
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "NUMBER_OF_PROCESSORS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
].map((name) => name.toLowerCase()));
function containedEnvironment() {
    const inherited = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (PASSED_THROUGH.has(name.toLowerCase()))
            inherited[name] = value;
    }
    return {
        ...inherited,
        ALL_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        HTTP_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "localhost,127.0.0.1,::1",
        all_proxy: "http://127.0.0.1:1",
        http_proxy: "http://127.0.0.1:1",
        https_proxy: "http://127.0.0.1:1",
        no_proxy: "localhost,127.0.0.1,::1",
        npm_config_offline: "true",
    };
}
async function copyCandidate(root, workspace) {
    let stdout;
    try {
        ;
        ({ stdout } = await execFileAsync("git", gitArgs(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]), { encoding: "utf8", maxBuffer: 256 * 1_024 * 1_024, shell: false, timeout: GIT_TIMEOUT_MS, windowsHide: true }));
    }
    catch {
        throw new ProofRefused("the candidate could not be listed: a proof runs against a copy, never against the repository");
    }
    const paths = stdout.split("\0").filter(Boolean);
    if (paths.length > MAX_COPIED_FILES) {
        throw new ProofRefused(`the candidate holds ${paths.length} files, above the ${MAX_COPIED_FILES} a disposable copy accepts`);
    }
    let bytes = 0;
    let copied = 0;
    for (const path of paths) {
        const source = join(root, path);
        const size = await sizeOf(source);
        if (size === null)
            continue;
        bytes += size;
        if (bytes > MAX_COPIED_BYTES) {
            throw new ProofRefused(`the candidate exceeds the ${MAX_COPIED_BYTES / (1_024 * 1_024)} MiB a disposable copy accepts`);
        }
        const target = join(workspace, path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        copied += 1;
    }
    return copied;
}
async function sizeOf(path) {
    try {
        const info = await stat(path);
        return info.isFile() ? info.size : null;
    }
    catch {
        return null;
    }
}
