import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
export async function resolveExecutable(name, environment = process.env, platform = process.platform) {
    if (name.includes("/") || name.includes("\\")) {
        const path = isAbsolute(name) ? name : join(process.cwd(), name);
        return (await isExecutableFile(path)) ? { kind: kindOf(path, platform), path } : null;
    }
    const directories = (environment["PATH"] ?? environment["Path"] ?? "").split(delimiter).filter(Boolean);
    const extensions = platform === "win32"
        ? (environment["PATHEXT"] ?? DEFAULT_PATHEXT).split(";").filter(Boolean)
        : [""];
    for (const directory of directories) {
        for (const extension of extensions) {
            const path = join(directory, name + extension);
            if (await isExecutableFile(path))
                return { kind: kindOf(path, platform), path };
        }
    }
    return null;
}
export async function probeVersion(name, args, timeoutMs, environment = process.env, platform = process.platform) {
    const resolved = await resolveExecutable(name, environment, platform);
    if (resolved === null)
        return null;
    if (resolved.kind === "shim")
        return { resolved, version: null };
    try {
        const { stdout } = await execFileAsync(resolved.path, [...args], {
            encoding: "utf8",
            shell: false,
            timeout: timeoutMs,
            windowsHide: true,
        });
        return { resolved, version: stdout.trim().split("\n")[0]?.trim() ?? null };
    }
    catch {
        return { resolved, version: null };
    }
}
function kindOf(path, platform) {
    if (platform !== "win32")
        return "binary";
    return /\.(?:bat|cmd)$/iu.test(path) ? "shim" : "binary";
}
async function isExecutableFile(path) {
    try {
        if (!(await stat(path)).isFile())
            return false;
        if (process.platform === "win32")
            return true;
        await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
