import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { arch, platform, version } from "node:process";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, DIGEST_DOMAIN, digest, digestBytes } from "../store/ids.js";
import { changedFiles } from "./changes.js";
import { gitArgs } from "../git.js";
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
export const MAX_PAYLOAD_BYTES = 2 * 1_024 * 1_024;
export const MAX_TOTAL_PAYLOAD_BYTES = 64 * 1_024 * 1_024;
const DEPENDENCY_FILES = [
    "Cargo.lock",
    "Cargo.toml",
    "Gemfile",
    "Gemfile.lock",
    "bun.lock",
    "bun.lockb",
    "composer.json",
    "composer.lock",
    "go.mod",
    "go.sum",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "pyproject.toml",
    "requirements.txt",
    "yarn.lock",
];
const CONFIGURATION_FILES = [
    ".editorconfig",
    ".gitattributes",
    ".nvmrc",
    ".python-version",
    "Makefile",
    "rust-toolchain.toml",
    "tsconfig.json",
];
export class CandidateRefused extends Error {
    constructor(message) {
        super(message);
        this.name = "CandidateRefused";
    }
}
export async function assertFreezable(root) {
    const inProgress = await firstPresent(root, [
        ".git/MERGE_HEAD",
        ".git/REBASE_HEAD",
        ".git/rebase-merge",
        ".git/rebase-apply",
        ".git/CHERRY_PICK_HEAD",
        ".git/REVERT_HEAD",
        ".git/BISECT_LOG",
    ]);
    if (inProgress !== null) {
        throw new CandidateRefused(`the repository is mid-operation (${inProgress}); finish or abort it before freezing a candidate`);
    }
    const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status === null) {
        throw new CandidateRefused("this directory is not a git repository, so a candidate cannot be frozen");
    }
    const unmerged = status
        .split("\0")
        .filter((record) => record.length >= 3 && /^(DD|AU|UD|UA|DU|AA|UU)/u.test(record))
        .map((record) => record.slice(3));
    if (unmerged.length > 0) {
        throw new CandidateRefused(`the repository has unmerged paths: ${unmerged.slice(0, 5).join(", ")}`);
    }
    const head = await git(root, ["rev-parse", "HEAD"]);
    if (head === null || !/^[0-9a-f]{40}$/u.test(head.trim())) {
        throw new CandidateRefused("the repository has no commit to use as a base revision; commit once before running a cycle");
    }
    return head.trim();
}
export async function captureCandidate(root) {
    const baseRevision = await assertFreezable(root);
    const changed = (await changedFiles(root)) ?? [];
    const files = changed.map((file) => ({
        digest: file.digest,
        kind: file.kind,
        path: file.path,
    }));
    const payloads = await readPayloads(root, changed);
    const manifest = {
        baseRevision,
        configurationDigest: await fileSetDigest(root, CONFIGURATION_FILES),
        dependencyStateDigest: await fileSetDigest(root, DEPENDENCY_FILES),
        diffDigest: await diffDigest(root, changed),
        environmentDigest: digest(DIGEST_DOMAIN.candidate, { arch, node: version, platform }),
        evidenceIds: [],
        files,
    };
    return {
        manifest: { ...manifest, candidateDigest: digest(DIGEST_DOMAIN.candidate, manifest) },
        payloads,
    };
}
async function readPayloads(root, changed) {
    const payloads = new Map();
    let total = 0;
    for (const file of changed) {
        if (file.kind === "deleted")
            continue;
        try {
            const info = await stat(join(root, file.path));
            if (!info.isFile() || info.size > MAX_PAYLOAD_BYTES)
                continue;
            if (total + info.size > MAX_TOTAL_PAYLOAD_BYTES)
                continue;
            payloads.set(file.path, await readFile(join(root, file.path)));
            total += info.size;
        }
        catch {
            continue;
        }
    }
    return payloads;
}
async function diffDigest(root, changed) {
    const diff = await gitBinary(root, ["diff", "HEAD", "--binary", "--no-color"]);
    const untracked = changed
        .filter((file) => file.kind === "added")
        .map((file) => ({ digest: file.digest, path: file.path }));
    return digestBytes(DIGEST_DOMAIN.candidate, Buffer.concat([diff ?? Buffer.alloc(0), Buffer.from(canonicalJson(untracked), "utf8")]));
}
async function fileSetDigest(root, names) {
    const entries = [];
    for (const name of names) {
        const bytes = await readIfPresent(join(root, name));
        if (bytes === null)
            continue;
        entries.push({ digest: digestBytes(DIGEST_DOMAIN.candidate, bytes), path: name });
    }
    return digest(DIGEST_DOMAIN.candidate, entries);
}
async function readIfPresent(path) {
    try {
        const info = await stat(path);
        return info.isFile() && info.size <= MAX_PAYLOAD_BYTES ? await readFile(path) : null;
    }
    catch {
        return null;
    }
}
async function firstPresent(root, relatives) {
    for (const relative of relatives) {
        try {
            await stat(join(root, ...relative.split("/")));
            return relative;
        }
        catch {
            continue;
        }
    }
    return null;
}
async function git(root, args) {
    try {
        const { stdout } = await execFileAsync("git", gitArgs(root, args), {
            encoding: "utf8",
            maxBuffer: 64 * 1_024 * 1_024,
            shell: false,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
        });
        return stdout;
    }
    catch {
        return null;
    }
}
async function gitBinary(root, args) {
    try {
        const { stdout } = await execFileAsync("git", gitArgs(root, args), {
            encoding: "buffer",
            maxBuffer: 256 * 1_024 * 1_024,
            shell: false,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
        });
        return stdout;
    }
    catch {
        return null;
    }
}
