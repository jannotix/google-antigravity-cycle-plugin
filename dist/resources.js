import { availableParallelism, cpus, freemem } from "node:os";
import { statfs } from "node:fs/promises";
export const MEMORY_RESERVE_BYTES = 1_024 ** 3;
export const DISK_RESERVE_BYTES = 2 * 1_024 ** 3;
export const CPU_CEILING = 0.85;
export const LEASE_SECONDS = 15;
export const RENEW_SECONDS = 5;
const SAMPLE_MAX_AGE_MS = 60_000;
const SAMPLE_GAP_MS = 100;
export const DEFAULT_RESERVES = {
    cpuCeiling: CPU_CEILING,
    diskReserveBytes: DISK_RESERVE_BYTES,
    memoryReserveBytes: MEMORY_RESERVE_BYTES,
};
export class CpuSampler {
    #previous;
    async read(now = Date.now()) {
        const current = snapshot(now);
        const previous = this.#previous;
        if (previous === undefined || now - previous.at > SAMPLE_MAX_AGE_MS) {
            const paired = await this.#pair(now);
            this.#previous = snapshot(Date.now());
            return paired;
        }
        this.#previous = current;
        return utilisation(previous, current);
    }
    async #pair(now) {
        const first = snapshot(now);
        await new Promise((resolve) => setTimeout(resolve, SAMPLE_GAP_MS));
        return utilisation(first, snapshot(Date.now()));
    }
}
function snapshot(at) {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
        idle += cpu.times.idle;
        total += cpu.times.idle + cpu.times.irq + cpu.times.nice + cpu.times.sys + cpu.times.user;
    }
    return { at, idle, total };
}
function utilisation(previous, current) {
    const total = current.total - previous.total;
    if (total <= 0)
        return null;
    const busy = total - (current.idle - previous.idle);
    return Math.min(1, Math.max(0, busy / total));
}
export async function readResources(dataDirectory, sampler, now = Date.now()) {
    return {
        availableDiskBytes: await availableDisk(dataDirectory),
        availableMemoryBytes: availableMemory(),
        cpuLoad: await sampler.read(now),
    };
}
export function pressure(reading, reserves = DEFAULT_RESERVES) {
    if (reading.availableMemoryBytes === null || reading.availableDiskBytes === null || reading.cpuLoad === null) {
        return "resource metrics are unavailable, so admission is deferred rather than assumed safe";
    }
    if (reading.availableMemoryBytes < reserves.memoryReserveBytes) {
        return `available memory (${gibibytes(reading.availableMemoryBytes)}) is below the ${gibibytes(reserves.memoryReserveBytes)} reserve`;
    }
    if (reading.availableDiskBytes < reserves.diskReserveBytes) {
        return `available disk (${gibibytes(reading.availableDiskBytes)}) is below the ${gibibytes(reserves.diskReserveBytes)} reserve`;
    }
    if (reading.cpuLoad > reserves.cpuCeiling) {
        return `cpu load (${Math.round(reading.cpuLoad * 100)}%) is above the ${Math.round(reserves.cpuCeiling * 100)}% ceiling`;
    }
    return null;
}
export function maximumActive(parallelism = availableParallelism()) {
    return Math.max(1, Math.min(8, Math.floor(parallelism / 2)));
}
export function gibibytes(bytes) {
    return `${(bytes / 1_024 ** 3).toFixed(1)} GiB`;
}
function availableMemory() {
    const free = freemem();
    return Number.isFinite(free) && free > 0 ? free : null;
}
async function availableDisk(path) {
    try {
        const stats = await statfs(path);
        const available = Number(stats.bavail) * Number(stats.bsize);
        return Number.isFinite(available) ? available : null;
    }
    catch {
        return null;
    }
}
