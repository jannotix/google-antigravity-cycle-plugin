import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  AdmissionController,
  activeLeases,
  expire,
  release,
  type Limits,
} from "../src/admission.ts"
import {
  CpuSampler,
  DEFAULT_RESERVES,
  maximumActive,
  pressure,
  type ResourceReading,
} from "../src/resources.ts"
import { readConfiguration } from "../src/config.ts"
import { Database } from "../src/store/database.ts"
import { control, startWorkflow } from "../src/workflow/service.ts"

const HEALTHY: ResourceReading = {
  availableDiskBytes: 20 * 1_024 ** 3,
  availableMemoryBytes: 8 * 1_024 ** 3,
  cpuLoad: 0.2,
}

const limits = (overrides: Partial<Limits> = {}): Limits => ({
  backpressureAdmissions: 1,
  leaseSeconds: 15,
  maxActive: 4,
  renewSeconds: 5,
  reserves: DEFAULT_RESERVES,
  ...overrides,
})

function fixture(overrides: Partial<Limits> = {}): {
  close: () => void
  controller: AdmissionController
  database: Database
} {
  const database = new Database({ path: ":memory:" })
  return {
    close: () => database.close(),
    controller: new AdmissionController(limits(overrides)),
    database,
  }
}

function workflow(database: Database, id: string, projectId: string): string {
  database.run(
    `insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at)
     values (?, ?, 'execution', 5, 1, 1)`,
    id,
    projectId,
  )
  return id
}

test("a healthy machine admits, and the lease says when to renew", () => {
  const { close, controller, database } = fixture()
  try {
    workflow(database, "w1", "p1")

    const admission = controller.request(database, "p1", "w1", HEALTHY, 1_000)

    assert.equal(admission.admitted, true)
    assert.equal(admission.expiresAt, 1_000 + 15_000)
    assert.equal(admission.renewWithinSeconds, 5)
    assert.deepEqual(
      activeLeases(database).map((lease) => lease.workflowId),
      ["w1"],
    )
  } finally {
    close()
  }
})

// Certification 10.2, 10.3, 10.4: pressure defers, and the reason says which reserve.
test("memory, disk and cpu pressure each defer admission with their own reason", () => {
  const { close, controller, database } = fixture()
  try {
    workflow(database, "w1", "p1")

    const lowMemory = controller.request(
      database,
      "p1",
      "w1",
      { ...HEALTHY, availableMemoryBytes: 512 * 1_024 ** 2 },
      1_000,
    )
    assert.equal(lowMemory.admitted, false)
    assert.match(lowMemory.reason, /available memory .* below the 1\.0 GiB reserve/u)

    const lowDisk = controller.request(
      database,
      "p1",
      "w1",
      { ...HEALTHY, availableDiskBytes: 1_024 ** 3 },
      1_000,
    )
    assert.match(lowDisk.reason, /available disk .* below the 2\.0 GiB reserve/u)

    const busy = controller.request(database, "p1", "w1", { ...HEALTHY, cpuLoad: 0.95 }, 1_000)
    assert.match(busy.reason, /cpu load \(95%\) is above the 85% ceiling/u)
    assert.deepEqual(activeLeases(database), [])
  } finally {
    close()
  }
})

// Certification 10.5. Unknown must never read as healthy.
test("a metric that could not be read defers rather than being assumed safe", () => {
  const { close, controller, database } = fixture()
  try {
    workflow(database, "w1", "p1")

    for (const missing of [
      { availableMemoryBytes: null },
      { availableDiskBytes: null },
      { cpuLoad: null },
    ] as const) {
      const admission = controller.request(database, "p1", "w1", { ...HEALTHY, ...missing }, 1_000)
      assert.equal(admission.admitted, false)
      assert.match(admission.reason, /metrics are unavailable/u)
    }
  } finally {
    close()
  }
})

test("admission stops at the configured maximum", () => {
  const { close, controller, database } = fixture({ maxActive: 2 })
  try {
    for (const id of ["w1", "w2", "w3"]) workflow(database, id, `p${id.slice(1)}`)

    assert.equal(controller.request(database, "p1", "w1", HEALTHY, 1_000).admitted, true)
    assert.equal(controller.request(database, "p2", "w2", HEALTHY, 1_000).admitted, true)

    const third = controller.request(database, "p3", "w3", HEALTHY, 1_000)
    assert.equal(third.admitted, false)
    assert.match(third.reason, /all 2 slots are held/u)
  } finally {
    close()
  }
})

// Certification 10.6. One project must not be able to take every slot while another waits.
test("no project takes more than its share while another is contending", () => {
  const { close, controller, database } = fixture({ maxActive: 4 })
  try {
    for (const id of ["a1", "a2", "a3", "b1"]) workflow(database, id, id.startsWith("a") ? "pa" : "pb")

    assert.equal(controller.request(database, "pa", "a1", HEALTHY, 1_000).admitted, true)
    assert.equal(controller.request(database, "pb", "b1", HEALTHY, 1_000).admitted, true)

    // Two projects are holding, so each is owed two of the four slots.
    assert.equal(controller.request(database, "pa", "a2", HEALTHY, 1_000).admitted, true)
    const beyond = controller.request(database, "pa", "a3", HEALTHY, 1_000)
    assert.equal(beyond.admitted, false)
    assert.match(beyond.reason, /its share of 2 of 4 slots/u)
  } finally {
    close()
  }
})

test("a single project uses every slot when nobody else is contending", () => {
  const { close, controller, database } = fixture({ maxActive: 3 })
  try {
    for (const id of ["w1", "w2", "w3"]) workflow(database, id, "p1")

    assert.equal(controller.request(database, "p1", "w1", HEALTHY, 1_000).admitted, true)
    assert.equal(controller.request(database, "p1", "w2", HEALTHY, 1_000).admitted, true)
    assert.equal(controller.request(database, "p1", "w3", HEALTHY, 1_000).admitted, true)
  } finally {
    close()
  }
})

// Certification 10.7.
test("an expired lease releases its slot", () => {
  const { close, controller, database } = fixture({ maxActive: 1 })
  try {
    workflow(database, "w1", "p1")
    workflow(database, "w2", "p2")
    controller.request(database, "p1", "w1", HEALTHY, 1_000)

    assert.equal(controller.request(database, "p2", "w2", HEALTHY, 2_000).admitted, false)

    // 15 seconds later the holder never renewed.
    assert.equal(controller.request(database, "p2", "w2", HEALTHY, 20_000).admitted, true)
    assert.deepEqual(
      activeLeases(database).map((lease) => lease.workflowId),
      ["w2"],
    )
  } finally {
    close()
  }
})

test("renewing extends a held lease and refuses one that expired", () => {
  const { close, controller, database } = fixture()
  try {
    workflow(database, "w1", "p1")
    controller.request(database, "p1", "w1", HEALTHY, 1_000)

    const renewed = controller.renew(database, "w1", 5_000)
    assert.equal(renewed.admitted, true)
    assert.equal(renewed.expiresAt, 20_000)

    const gone = controller.renew(database, "w1", 100_000)
    assert.equal(gone.admitted, false)
    assert.match(gone.reason, /expired/u)
  } finally {
    close()
  }
})

test("asking again while holding a lease renews it rather than losing the slot", () => {
  const { close, controller, database } = fixture({ maxActive: 1 })
  try {
    workflow(database, "w1", "p1")
    controller.request(database, "p1", "w1", HEALTHY, 1_000)

    const again = controller.request(database, "p1", "w1", HEALTHY, 5_000)
    assert.equal(again.admitted, true)
    assert.equal(activeLeases(database).length, 1)
  } finally {
    close()
  }
})

// Backpressure: after a pressured reading the machine is let recover instead of being refilled.
test("admissions are throttled while the machine recovers from pressure", () => {
  const { close, controller, database } = fixture({ maxActive: 4 })
  try {
    for (const id of ["w1", "w2", "w3"]) workflow(database, id, "p1")

    assert.equal(controller.request(database, "p1", "w1", { ...HEALTHY, cpuLoad: 0.99 }, 1_000).admitted, false)
    assert.equal(controller.request(database, "p1", "w2", HEALTHY, 2_000).admitted, true)

    const throttled = controller.request(database, "p1", "w3", HEALTHY, 3_000)
    assert.equal(throttled.admitted, false)
    assert.match(throttled.reason, /recovering from resource pressure/u)

    // Once the recovery window has passed, ordinary admission resumes.
    assert.equal(controller.request(database, "p1", "w3", HEALTHY, 60_000).admitted, true)
  } finally {
    close()
  }
})

test("releasing gives the slot back immediately", () => {
  const { close, controller, database } = fixture({ maxActive: 1 })
  try {
    workflow(database, "w1", "p1")
    workflow(database, "w2", "p2")
    controller.request(database, "p1", "w1", HEALTHY, 1_000)
    release(database, "w1")

    assert.equal(controller.request(database, "p2", "w2", HEALTHY, 1_100).admitted, true)
  } finally {
    close()
  }
})

// Certification 10.1: durable state for a hundred workflows across projects.
test("a hundred registered workflows across projects stay governed and intact", () => {
  const { close, controller, database } = fixture({ maxActive: 4 })
  try {
    for (let index = 0; index < 100; index += 1) {
      workflow(database, `w${index}`, `p${index % 10}`)
    }

    let admitted = 0
    for (let index = 0; index < 100; index += 1) {
      if (controller.request(database, `p${index % 10}`, `w${index}`, HEALTHY, 1_000).admitted) {
        admitted += 1
      }
    }

    assert.equal(admitted, 4, "never more than the maximum are active at once")
    assert.equal(activeLeases(database).length, 4)
    assert.equal(
      Number(
        database.get<{ total: number }>("select count(*) as total from workflows")?.total ?? 0,
      ),
      100,
      "every workflow is still registered",
    )
    assert.equal(new Set(activeLeases(database).map((lease) => lease.projectId)).size, 4)
  } finally {
    close()
  }
})

test("the report says what the machine has and what this project holds", () => {
  const { close, controller, database } = fixture({ maxActive: 2 })
  try {
    workflow(database, "w1", "p1")
    controller.request(database, "p1", "w1", HEALTHY, 1_000)

    const report = controller.report(database, "p1", HEALTHY, 2_000) as {
      active: unknown[]
      limits: { maxActive: number }
      pressure: string | null
      share: { held: number; of: number }
    }

    assert.equal(report.pressure, null)
    assert.equal(report.limits.maxActive, 2)
    assert.equal(report.active.length, 1)
    assert.deepEqual(report.share, { held: 1, of: 2 })
  } finally {
    close()
  }
})

test("expiring reports how many slots it reclaimed", () => {
  const { close, controller, database } = fixture()
  try {
    workflow(database, "w1", "p1")
    controller.request(database, "p1", "w1", HEALTHY, 1_000)

    assert.equal(expire(database, 2_000), 0)
    assert.equal(expire(database, 100_000), 1)
    assert.deepEqual(activeLeases(database), [])
  } finally {
    close()
  }
})

test("the maximum is derived from logical cpus and clamped at both ends", () => {
  assert.equal(maximumActive(1), 1)
  assert.equal(maximumActive(8), 4)
  assert.equal(maximumActive(128), 8)
})

test("pressure is silent on a healthy machine", () => {
  assert.equal(pressure(HEALTHY), null)
})

test("cpu utilisation is measured, not assumed", async () => {
  const sampler = new CpuSampler()
  const load = await sampler.read()

  assert.ok(load === null || (load >= 0 && load <= 1), `unexpected load: ${String(load)}`)
  const second = await sampler.read()
  assert.ok(second === null || (second >= 0 && second <= 1))
})

// A workflow that can no longer use its slot must not keep it until the lease expires.
test("a workflow that stops holds no slot", async () => {
  const { close, controller, database } = fixture({ maxActive: 1 })
  try {
    const context = {
      configuration: readConfiguration({}),
      database,
      dataDirectory: mkdtempSync(join(tmpdir(), "cycle-admission-")),
      maxRepairCycles: 5,
      projectId: "p1",
    }
    const started = startWorkflow(context, "add a health endpoint", [], "quick") as {
      workflowId: string
    }
    workflow(database, "other", "p2")

    assert.equal(controller.request(database, "p1", started.workflowId, HEALTHY, 1_000).admitted, true)
    assert.equal(controller.request(database, "p2", "other", HEALTHY, 1_000).admitted, false)

    control(context, started.workflowId, "cancel")

    assert.deepEqual(activeLeases(database), [], "cancelling released the slot")
    assert.equal(controller.request(database, "p2", "other", HEALTHY, 1_000).admitted, true)
    rmSync(context.dataDirectory, { force: true, recursive: true })
  } finally {
    close()
  }
})
