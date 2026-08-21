import type { Database, Row } from "./store/database.ts"
import {
  DEFAULT_RESERVES,
  LEASE_SECONDS,
  RENEW_SECONDS,
  maximumActive,
  pressure,
  type Reserves,
  type ResourceReading,
} from "./resources.ts"

export interface Limits {
  /** Admissions permitted per lease window while the machine is recovering from pressure. */
  readonly backpressureAdmissions: number
  readonly leaseSeconds: number
  readonly maxActive: number
  readonly renewSeconds: number
  readonly reserves: Reserves
}

export function defaultLimits(): Limits {
  return {
    backpressureAdmissions: 1,
    leaseSeconds: LEASE_SECONDS,
    maxActive: maximumActive(),
    renewSeconds: RENEW_SECONDS,
    reserves: DEFAULT_RESERVES,
  }
}

export interface Lease {
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly projectId: string
  readonly workflowId: string
}

export interface Admission {
  readonly admitted: boolean
  readonly expiresAt: number | null
  readonly reason: string
  readonly renewWithinSeconds: number
}

/**
 * Lease-based admission. The control plane governs how many workflows are active at once; it does
 * not execute them, and it never blocks — a workflow that cannot be admitted is told why and when to
 * ask again, so nothing waits on a promise nobody is keeping.
 *
 * Pressure is a property of this moment, so the recovery state lives in this object rather than in
 * the store: a control plane that restarts should re-measure, not inherit a stale opinion of the
 * machine.
 */
export class AdmissionController {
  readonly #limits: Limits
  #pressuredAt: number | null = null

  constructor(limits: Limits = defaultLimits()) {
    this.#limits = limits
  }

  get limits(): Limits {
    return this.#limits
  }

  request(
    database: Database,
    projectId: string,
    workflowId: string,
    reading: ResourceReading,
    now = Date.now(),
  ): Admission {
    expire(database, now)

    // Already holding one: renewing is the same operation, so a caller that lost track of its lease
    // cannot lose its slot to itself.
    const held = leaseOf(database, workflowId)
    if (held !== undefined) return this.#grant(database, projectId, workflowId, now)

    const blocked = pressure(reading, this.#limits.reserves)
    if (blocked !== null) {
      this.#pressuredAt = now
      return this.#defer(blocked)
    }

    if (this.#recovering(now)) {
      const recent = database.get<{ total: number }>(
        "select count(*) as total from leases where acquired_at > ?",
        now - this.#limits.leaseSeconds * 1_000,
      )
      if ((recent?.total ?? 0) >= this.#limits.backpressureAdmissions) {
        return this.#defer(
          "the machine is recovering from resource pressure, so admissions are throttled",
        )
      }
    }

    const active = count(database, "select count(*) as total from leases")
    if (active >= this.#limits.maxActive) {
      return this.#defer(`all ${this.#limits.maxActive} slots are held`)
    }

    const share = this.#share(database, projectId)
    const mine = count(
      database,
      "select count(*) as total from leases where project_id = ?",
      projectId,
    )
    if (mine >= share) {
      return this.#defer(
        `this project already holds its share of ${share} of ${this.#limits.maxActive} slots`,
      )
    }

    return this.#grant(database, projectId, workflowId, now)
  }

  renew(database: Database, workflowId: string, now = Date.now()): Admission {
    expire(database, now)
    const held = leaseOf(database, workflowId)
    if (held === undefined) {
      return this.#defer("this lease expired; request admission again before continuing")
    }
    return this.#grant(database, held.projectId, workflowId, now)
  }

  report(database: Database, projectId: string, reading: ResourceReading, now = Date.now()): unknown {
    expire(database, now)
    return {
      active: activeLeases(database),
      limits: {
        backpressureAdmissions: this.#limits.backpressureAdmissions,
        leaseSeconds: this.#limits.leaseSeconds,
        maxActive: this.#limits.maxActive,
        renewSeconds: this.#limits.renewSeconds,
      },
      pressure: pressure(reading, this.#limits.reserves),
      recovering: this.#recovering(now),
      reserves: {
        cpuCeilingPercent: Math.round(this.#limits.reserves.cpuCeiling * 100),
        diskReserveBytes: this.#limits.reserves.diskReserveBytes,
        memoryReserveBytes: this.#limits.reserves.memoryReserveBytes,
      },
      resources: reading,
      share: { held: count(database, "select count(*) as total from leases where project_id = ?", projectId), of: this.#share(database, projectId) },
    }
  }

  /**
   * A project's share of the slots. Every project holding a lease counts, plus this one if it holds
   * none, so a project arriving at a busy control plane is always owed at least one slot and no
   * project can take every slot while another waits.
   */
  #share(database: Database, projectId: string): number {
    const projects = count(database, "select count(distinct project_id) as total from leases")
    const mine = count(
      database,
      "select count(*) as total from leases where project_id = ?",
      projectId,
    )
    const contenders = Math.max(1, projects + (mine === 0 ? 1 : 0))
    return Math.max(1, Math.floor(this.#limits.maxActive / contenders))
  }

  #recovering(now: number): boolean {
    return this.#pressuredAt !== null && now - this.#pressuredAt < this.#limits.leaseSeconds * 1_000
  }

  #grant(database: Database, projectId: string, workflowId: string, now: number): Admission {
    const expiresAt = now + this.#limits.leaseSeconds * 1_000
    database.run(
      `insert into leases (workflow_id, project_id, acquired_at, expires_at) values (?, ?, ?, ?)
       on conflict (workflow_id) do update set expires_at = excluded.expires_at`,
      workflowId,
      projectId,
      now,
      expiresAt,
    )
    return {
      admitted: true,
      expiresAt,
      reason: `admitted for ${this.#limits.leaseSeconds}s`,
      renewWithinSeconds: this.#limits.renewSeconds,
    }
  }

  #defer(reason: string): Admission {
    return {
      admitted: false,
      expiresAt: null,
      reason,
      renewWithinSeconds: this.#limits.renewSeconds,
    }
  }
}

/** An expired lease releases its slot: a session that died holds nothing. */
export function expire(database: Database, now = Date.now()): number {
  const stale = count(database, "select count(*) as total from leases where expires_at <= ?", now)
  if (stale > 0) database.run("delete from leases where expires_at <= ?", now)
  return stale
}

export function release(database: Database, workflowId: string): void {
  database.run("delete from leases where workflow_id = ?", workflowId)
}

export function activeLeases(database: Database): Lease[] {
  return database
    .all<Row>("select * from leases order by acquired_at")
    .map((row) => ({
      acquiredAt: Number(row["acquired_at"]),
      expiresAt: Number(row["expires_at"]),
      projectId: String(row["project_id"]),
      workflowId: String(row["workflow_id"]),
    }))
}

function leaseOf(database: Database, workflowId: string): Lease | undefined {
  const row = database.get<Row>("select * from leases where workflow_id = ?", workflowId)
  return row === undefined
    ? undefined
    : {
        acquiredAt: Number(row["acquired_at"]),
        expiresAt: Number(row["expires_at"]),
        projectId: String(row["project_id"]),
        workflowId: String(row["workflow_id"]),
      }
}

function count(database: Database, sql: string, ...parameters: readonly (number | string)[]): number {
  return Number(database.get<{ total: number }>(sql, ...parameters)?.total ?? 0)
}
