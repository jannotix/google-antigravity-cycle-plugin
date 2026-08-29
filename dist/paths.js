import { homedir } from "node:os";
import { join, win32, posix } from "node:path";
const PRODUCT_DIRECTORY = "cycle";
export class PathError extends Error {
    constructor(message) {
        super(message);
        this.name = "PathError";
    }
}
export function resolveDataDirectory(configured, environment = process.env, platform = process.platform) {
    if (configured)
        return configured;
    const path = platform === "win32" ? win32 : posix;
    if (platform === "win32") {
        const base = environment["LOCALAPPDATA"];
        if (!base)
            throw new PathError("LOCALAPPDATA is not set");
        return path.join(base, "Cycle");
    }
    if (platform === "darwin") {
        return path.join(homedir(), "Library", "Application Support", "Cycle");
    }
    const base = environment["XDG_DATA_HOME"] || path.join(homedir(), ".local", "share");
    return path.join(base, PRODUCT_DIRECTORY);
}
export function settingsPath(environment = process.env) {
    const configured = environment["ANTIGRAVITY_CONFIG_DIR"] || environment["GEMINI_CONFIG_DIR"];
    return join(configured || join(homedir(), ".gemini", "antigravity-cli"), "settings.json");
}
