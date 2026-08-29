import { createHash } from "node:crypto";
import { resolve } from "node:path";
export function identifyProject(directory, environment = process.env) {
    const path = resolve(directory || environment["ANTIGRAVITY_PROJECT_DIR"] || environment["CYCLE_PROJECT_DIR"] || process.cwd());
    const normalized = process.platform === "win32" ? path.toLowerCase() : path;
    return {
        id: createHash("sha256").update(normalized).digest("hex").slice(0, 32),
        path,
    };
}
