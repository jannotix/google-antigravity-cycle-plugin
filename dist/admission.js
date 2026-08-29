import { DEFAULT_RESERVES, LEASE_SECONDS, RENEW_SECONDS, maximumActive, pressure, } from "./resources.js";
export function defaultLimits() {
    return {
        backpressureAdmissions: 1,
        leaseSeconds: LEASE_SECONDS,
        maxActive: maximumActive(),
        renewSeconds: RENEW_SECONDS,
        reserves: DEFAULT_RESERVES,
    };
}
export class AdmissionController {
    #limits;
    #pressuredAt = null;
    constructor(limits = defaultLimits()) {
        this.#limits = limits;
    }
    get limits() {
        return this.#limits;
    }
    request(database, projectId, workflowId, reading, now = Date.now()) {
        expire(database, now);
        const held = leaseOf(database, workflowId);
        if (held !== undefined)
            return this.#grant(database, projectId, workflowId, now);
        const blocked = pressure(reading, this.#limits.reserves);
        if (blocked !== null) {
            this.#pressuredAt = now;
            return this.#defer(blocked);
        }
        if (this.#recovering(now)) {
            const recent = database.get("select count(*) as total from leases where acquired_at > ?", now - this.#limits.leaseSeconds * 1_000);
            if ((recent?.total ?? 0) >= this.#limits.backpressureAdmissions) {
                return this.#defer("the machine is recovering from resource pressure, so admissions are throttled");
            }
        }
        const active = count(database, "select count(*) as total from leases");
        if (active >= this.#limits.maxActive) {
            return this.#defer(`all ${this.#limits.maxActive} slots are held`);
        }
        const share = this.#share(database, projectId);
        const mine = count(database, "select count(*) as total from leases where project_id = ?", projectId);
        if (mine >= share) {
            return this.#defer(`this project already holds its share of ${share} of ${this.#limits.maxActive} slots`);
        }
        return this.#grant(database, projectId, workflowId, now);
    }
    renew(database, workflowId, now = Date.now()) {
        expire(database, now);
        const held = leaseOf(database, workflowId);
        if (held === undefined) {
            return this.#defer("this lease expired; request admission again before continuing");
        }
        return this.#grant(database, held.projectId, workflowId, now);
    }
    report(database, projectId, reading, now = Date.now()) {
        expire(database, now);
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
        };
    }
    #share(database, projectId) {
        const projects = count(database, "select count(distinct project_id) as total from leases");
        const mine = count(database, "select count(*) as total from leases where project_id = ?", projectId);
        const contenders = Math.max(1, projects + (mine === 0 ? 1 : 0));
        return Math.max(1, Math.floor(this.#limits.maxActive / contenders));
    }
    #recovering(now) {
        return this.#pressuredAt !== null && now - this.#pressuredAt < this.#limits.leaseSeconds * 1_000;
    }
    #grant(database, projectId, workflowId, now) {
        const expiresAt = now + this.#limits.leaseSeconds * 1_000;
        database.run(`insert into leases (workflow_id, project_id, acquired_at, expires_at) values (?, ?, ?, ?)
       on conflict (workflow_id) do update set expires_at = excluded.expires_at`, workflowId, projectId, now, expiresAt);
        return {
            admitted: true,
            expiresAt,
            reason: `admitted for ${this.#limits.leaseSeconds}s`,
            renewWithinSeconds: this.#limits.renewSeconds,
        };
    }
    #defer(reason) {
        return {
            admitted: false,
            expiresAt: null,
            reason,
            renewWithinSeconds: this.#limits.renewSeconds,
        };
    }
}
export function expire(database, now = Date.now()) {
    const stale = count(database, "select count(*) as total from leases where expires_at <= ?", now);
    if (stale > 0)
        database.run("delete from leases where expires_at <= ?", now);
    return stale;
}
export function release(database, workflowId) {
    database.run("delete from leases where workflow_id = ?", workflowId);
}
export function activeLeases(database) {
    return database
        .all("select * from leases order by acquired_at")
        .map((row) => ({
        acquiredAt: Number(row["acquired_at"]),
        expiresAt: Number(row["expires_at"]),
        projectId: String(row["project_id"]),
        workflowId: String(row["workflow_id"]),
    }));
}
function leaseOf(database, workflowId) {
    const row = database.get("select * from leases where workflow_id = ?", workflowId);
    return row === undefined
        ? undefined
        : {
            acquiredAt: Number(row["acquired_at"]),
            expiresAt: Number(row["expires_at"]),
            projectId: String(row["project_id"]),
            workflowId: String(row["workflow_id"]),
        };
}
function count(database, sql, ...parameters) {
    return Number(database.get(sql, ...parameters)?.total ?? 0);
}
