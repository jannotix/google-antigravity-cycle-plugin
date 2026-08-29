import { newId } from "../store/ids.js";
import { outputDigest } from "./digest.js";
export const DEFAULT_TIMEOUT_SECONDS = 600;
export function evidenceFor(gate, startedAt, status, extra = {}) {
    const output = extra.output ?? "";
    return {
        exitCode: null,
        finishedAt: Date.now(),
        gate,
        id: newId(),
        output,
        outputDigest: outputDigest(`${gate.name}::${output}`),
        skipReason: extra.skipReason ?? null,
        startedAt,
        status,
    };
}
