import { availableParallelism, cpus, freemem } from "node:os"
import { statfs } from "node:fs/promises"

/** Section 13. Reserves are what the machine keeps, not what Cycle is allowed to take. */
export const MEMORY_RESERVE_BYTES = 1_024 ** 3
export const DISK_RESERVE_BYTES = 2 * 1_024 ** 3
export const CPU_CEILING = 0.85
export const LEASE_SECONDS = 15
export const RENEW_SECONDS = 5

/** One sample is stale after this, and a fresh pair is taken rather than a stale delta reused. */
const SAMPLE_MAX_AGE_MS = 60_000
const SAMPLE_GAP_MS = 100

export interface Reserves {
  readonly cpuCeiling: number
  readonly diskReserveBytes: number
  readonly memoryReserveBytes: number
}

export const DEFAULT_RESERVES: Reserves = {
  cpuCeiling: CPU_CEILING,
  diskReserveBytes: DISK_RESERVE_BYTES,
  memoryReserveBytes: MEMORY_RESERVE_BYTES,
}

export interface ResourceReading {
  readonly availableDiskBytes: number | null
  readonly availableMemoryBytes: number | null
  /** Fraction of the machine's CPU in use, 0 to 1. */
  readonly cpuLoad: number | null
}

interface Sample {
  readonly at: number
  readonly idle: number
  readonly total: number
}

/**
 * CPU utilisation from the difference between two snapshots of the kernel's own counters. `loadavg`
 * is not used: it reports zero on Windows, and a metric that silently reads healthy on one platform
 * is worse than no metric at all.
 */
export class CpuSampler {
  #previous: Sample | undefined

  async read(now = Date.now()): Promise<number | null> {
    const current = snapshot(now)
    const previous = this.#previous

    if (previous === undefined || now - previous.at > SAMPLE_MAX_AGE_MS) {
      const paired = await this.#pair(now)
      this.#previous = snapshot(Date.now())
      return paired
    }

    this.#previous = current
    return utilisation(previous, current)
  }

  async #pair(now: number): Promise<number | null> {
    const first = snapshot(now)
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_GAP_MS))
    return utilisation(first, snapshot(Date.now()))
  }
}

function snapshot(at: number): Sample {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    idle += cpu.times.idle
    total += cpu.times.idle + cpu.times.irq + cpu.times.nice + cpu.times.sys + cpu.times.user
  }
  return { at, idle, total }
}

function utilisation(previous: Sample, current: Sample): number | null {
  const total = current.total - previous.total
  if (total <= 0) return null
  const busy = total - (current.idle - previous.idle)
  return Math.min(1, Math.max(0, busy / total))
}

export async function readResources(
  dataDirectory: string,
  sampler: CpuSampler,
  now = Date.now(),
): Promise<ResourceReading> {
  return {
    availableDiskBytes: await availableDisk(dataDirectory),
    availableMemoryBytes: availableMemory(),
    cpuLoad: await sampler.read(now),
  }
}

/**
 * The reason to defer, or null when there is none. A metric that could not be read defers too:
 * "unknown" is never allowed to mean "healthy", which is how a machine gets driven into swap by
 * something that was sure it had room.
 */
export function pressure(reading: ResourceReading, reserves: Reserves = DEFAULT_RESERVES): string | null {
  if (reading.availableMemoryBytes === null || reading.availableDiskBytes === null || reading.cpuLoad === null) {
    return "resource metrics are unavailable, so admission is deferred rather than assumed safe"
  }
  if (reading.availableMemoryBytes < reserves.memoryReserveBytes) {
    return `available memory (${gibibytes(reading.availableMemoryBytes)}) is below the ${gibibytes(reserves.memoryReserveBytes)} reserve`
  }
  if (reading.availableDiskBytes < reserves.diskReserveBytes) {
    return `available disk (${gibibytes(reading.availableDiskBytes)}) is below the ${gibibytes(reserves.diskReserveBytes)} reserve`
  }
  if (reading.cpuLoad > reserves.cpuCeiling) {
    return `cpu load (${Math.round(reading.cpuLoad * 100)}%) is above the ${Math.round(reserves.cpuCeiling * 100)}% ceiling`
  }
  return null
}

/** Derived from logical CPUs and clamped: a machine with 64 cores is still one developer's laptop. */
export function maximumActive(parallelism = availableParallelism()): number {
  return Math.max(1, Math.min(8, Math.floor(parallelism / 2)))
}

export function gibibytes(bytes: number): string {
  return `${(bytes / 1_024 ** 3).toFixed(1)} GiB`
}

function availableMemory(): number | null {
  const free = freemem()
  return Number.isFinite(free) && free > 0 ? free : null
}

async function availableDisk(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path)
    const available = Number(stats.bavail) * Number(stats.bsize)
    return Number.isFinite(available) ? available : null
  } catch {
    return null
  }
}
