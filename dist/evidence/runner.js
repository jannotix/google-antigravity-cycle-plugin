import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { assertSafe } from "../workflow/commands.js";
import { resolveExecutable } from "../exec.js";
import { outputDigest, outputHash } from "./digest.js";
export const MAX_OUTPUT_BYTES = 1_024 * 1_024;
const SHIM_ENTRY_POINTS = {
    npm: ["node_modules/npm/bin/npm-cli.js"],
    npx: ["node_modules/npm/bin/npx-cli.js"],
    pnpm: ["node_modules/pnpm/bin/pnpm.cjs", "node_modules/pnpm/bin/pnpm.js"],
    pnpx: ["node_modules/pnpm/bin/pnpx.cjs", "node_modules/pnpm/bin/pnpx.js"],
    yarn: ["node_modules/yarn/bin/yarn.js"],
};
export async function resolveRunnable(program, environment = process.env, platform = process.platform) {
    const resolved = await resolveExecutable(program, environment, platform);
    if (resolved === null)
        return { unavailable: `${program} was not found on PATH` };
    if (resolved.kind === "binary")
        return { arguments: [], file: resolved.path };
    const name = basename(resolved.path).replace(/\.(cmd|bat)$/iu, "").toLowerCase();
    const entries = SHIM_ENTRY_POINTS[name];
    if (entries === undefined) {
        return {
            unavailable: `${program} resolves to the shim ${resolved.path}, which has no known entry point; ` +
                "gates never fall back to a shell",
        };
    }
    for (const entry of entries) {
        const candidate = join(dirname(resolved.path), ...entry.split("/"));
        if (await isFile(candidate))
            return { arguments: [candidate], file: process.execPath };
    }
    return {
        unavailable: `${program} resolves to the shim ${resolved.path} but its entry point is missing ` +
            `(looked for ${entries.join(", ")})`,
    };
}
export async function runCommand(command, options) {
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    try {
        assertSafe(command.program, command.arguments);
    }
    catch (error) {
        return unavailable(command, error instanceof Error ? error.message : String(error));
    }
    const runnable = await resolveRunnable(command.program, environment, platform);
    if ("unavailable" in runnable)
        return unavailable(command, runnable.unavailable);
    const args = [...runnable.arguments, ...command.arguments];
    const invocation = [runnable.file, ...args].join(" ");
    return await new Promise((resolve) => {
        const child = spawn(runnable.file, args, {
            cwd: options.cwd,
            env: {
                ...environment,
                CI: "1",
                NO_COLOR: "1",
            },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const hash = outputHash();
        const kept = [];
        let keptBytes = 0;
        let timedOut = false;
        let settled = false;
        const absorb = (chunk) => {
            hash.update(chunk);
            if (keptBytes >= MAX_OUTPUT_BYTES)
                return;
            const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - keptBytes);
            kept.push(slice);
            keptBytes += slice.byteLength;
        };
        child.stdout.on("data", absorb);
        child.stderr.on("data", absorb);
        const timer = setTimeout(() => {
            timedOut = true;
            terminate(child, platform);
        }, options.timeoutSeconds * 1_000);
        const finish = (exitCode, failure) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const output = Buffer.concat(kept).toString("utf8");
            resolve({
                exitCode,
                invocation,
                output: failure === undefined ? output : `${output}\n${failure}`.trim(),
                outputDigest: hash.digest("hex"),
                timedOut,
                unavailable: null,
            });
        };
        child.on("error", (error) => finish(null, `could not run ${command.program}: ${error.message}`));
        child.on("close", (code) => finish(code));
    });
}
function terminate(child, platform) {
    if (child.pid === undefined)
        return;
    if (platform !== "win32") {
        child.kill("SIGKILL");
        return;
    }
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => child.kill("SIGKILL"));
}
function unavailable(command, reason) {
    return {
        exitCode: null,
        invocation: [command.program, ...command.arguments].join(" "),
        output: "",
        outputDigest: outputDigest(""),
        timedOut: false,
        unavailable: reason,
    };
}
async function isFile(path) {
    try {
        return (await stat(path)).isFile();
    }
    catch {
        return false;
    }
}
