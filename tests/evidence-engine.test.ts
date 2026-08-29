import { readConfiguration } from "../src/config.ts"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import type { GateStrictness } from "../src/config.ts"
import { captureCandidate } from "../src/evidence/candidate.ts"
import { parseStatus } from "../src/evidence/changes.ts"
import { verify } from "../src/evidence/engine.ts"
import { reimplementedCapabilities } from "../src/evidence/essentiality.ts"
import { Database } from "../src/store/database.ts"
import { loadEvidence, type StoredEvidence } from "../src/store/evidence.ts"
import { replaceFile } from "../src/store/graph.ts"
import {
  freezeCandidate,
  startWorkflow,
  submitBrowserEvidence,
  type ServiceContext,
} from "../src/workflow/service.ts"

interface Fixture {
  readonly close: () => void
  readonly ctx: ServiceContext
  readonly root: string
  readonly write: (path: string, content: string) => void
}

function fixture(baseline: Record<string, string> = { "README.md": "# fixture\n" }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "cycle-engine-"))
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" })
  }
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  git("init", "--quiet")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  // A machine-wide core.hooksPath would run the developer's own hooks inside the fixture.
  const hooks = join(root, ".githooks-empty")
  mkdirSync(hooks, { recursive: true })
  git("config", "core.hooksPath", hooks)
  for (const [path, content] of Object.entries(baseline)) write(path, content)
  git("add", "-A")
  git("commit", "--quiet", "-m", "baseline")

  const database = new Database({ path: ":memory:" })
  // Outside the repository on purpose: the control plane's own key and store must never become
  // part of the candidate it is verifying.
  const data = mkdtempSync(join(tmpdir(), "cycle-engine-data-"))
  return {
    close: () => {
      database.close()
      rmSync(root, { force: true, recursive: true })
      rmSync(data, { force: true, recursive: true })
    },
    ctx: { configuration: readConfiguration({}), database, dataDirectory: data, maxRepairCycles: 5, projectId: "p1" },
    root,
    write,
  }
}

/** The secret the plane issued to the functional reviewer for this workflow's frozen candidate. */
function reviewerToken(workflowId: string): string {
  const token = issued.get(workflowId)
  if (token === undefined) throw new Error("no capture capability was issued for this workflow")
  return token
}

const issued = new Map<string, string>()

async function freeze(item: Fixture): Promise<string> {
  const started = startWorkflow(item.ctx, "change the fixture", [], "quick") as {
    workflowId: string
  }
  const frozen = freezeCandidate(item.ctx, started.workflowId, await captureCandidate(item.root)) as {
    captureCapabilities: { role: string; token: string }[]
  }
  const functional = frozen.captureCapabilities.find((entry) => entry.role === "functional_reviewer")
  if (functional !== undefined) issued.set(started.workflowId, functional.token)
  return started.workflowId
}

async function verifyFixture(
  item: Fixture,
  workflowId: string,
  strictness: GateStrictness = "standard",
  taskCommands: readonly string[] = [],
) {
  const candidateId = item.ctx.database.get<{ id: string }>(
    "select id from candidates where workflow_id = ?",
    workflowId,
  )!.id

  const outcome = await verify({
    candidateId,
    database: item.ctx.database,
    projectId: item.ctx.projectId,
    root: item.root,
    strictness,
    taskCommands,
  })
  return { evidence: loadEvidence(item.ctx.database, candidateId), outcome }
}

const gate = (evidence: readonly StoredEvidence[], name: string): StoredEvidence | undefined =>
  evidence.find((item) => item.gateName === name)

/** The recorded text of one gate, which the reviewers read and the store keeps verbatim. */
const gateOutput = (item: Fixture, gateName: string): string =>
  String(
    item.ctx.database.get<{ output: string }>(
      "select output from evidence where gate_name = ? order by finished_at desc limit 1",
      gateName,
    )?.output ?? "",
  )

// Certification 5.7.
test("a secret in changed content fails the candidate", async () => {
  const item = fixture()
  try {
    item.write("src/client.ts", 'export const key = "AKIAIOSFODNN7EXAMPLE"\n')
    const workflowId = await freeze(item)

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "security:changed-content-secrets")?.status, "failed")
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})

// The bytes that were frozen are the bytes that get verified. Anything else verifies one candidate
// and delivers another.
// Certification 7.1.
test("a file changed after the freeze aborts verification", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 41\n")
    const workflowId = await freeze(item)
    item.write("src/app.ts", "export const answer = 42\n")

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "integrity:candidate")?.status, "failed")
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})

test("a candidate that changed nothing does not verify", async () => {
  const item = fixture()
  try {
    const workflowId = await freeze(item)

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "integrity:candidate")?.status, "failed")
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})

test("a clean candidate with no required layer passes", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const workflowId = await freeze(item)

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "integrity:candidate")?.status, "passed")
    assert.equal(gate(evidence, "security:changed-content-secrets")?.status, "passed")
    assert.equal(outcome.mandatoryPassed, true)
  } finally {
    item.close()
  }
})

// The rejection cases are the product: a layer touched with no proof of it is a failure.
test("a UI change with no browser gate is refused", async () => {
  const item = fixture()
  try {
    item.write("src/components/Banner.tsx", "export const Banner = () => null\n")
    const workflowId = await freeze(item)

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "browser:affected-user-flow")?.status, "failed")
    assert.equal(gate(evidence, "accessibility:affected-user-flow")?.status, "failed")
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})

// Certification 5.17.
test("advisory records the missing proof as a warning and lets the candidate through", async () => {
  const item = fixture()
  try {
    item.write("src/components/Banner.tsx", "export const Banner = () => null\n")
    const workflowId = await freeze(item)

    const { evidence, outcome } = await verifyFixture(item, workflowId, "advisory")

    const browser = gate(evidence, "browser:affected-user-flow")
    assert.equal(browser?.status, "warning")
    assert.equal(browser?.mandatory, false)
    assert.equal(outcome.mandatoryPassed, true)
  } finally {
    item.close()
  }
})

test("a failing verification command fails the candidate", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    item.write("check.mjs", "process.exit(1)\n")
    const workflowId = await freeze(item)

    const { evidence, outcome } = await verifyFixture(item, workflowId, "standard", [
      "node check.mjs",
    ])

    assert.equal(gate(evidence, "command:node check.mjs")?.status, "failed")
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})

test("a passing verification command is recorded as evidence a reviewer can cite", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    item.write("check.mjs", "process.exit(0)\n")
    const workflowId = await freeze(item)

    const { evidence, outcome } = await verifyFixture(item, workflowId, "standard", [
      "node check.mjs",
    ])

    assert.equal(gate(evidence, "command:node check.mjs")?.status, "passed")
    assert.equal(outcome.mandatoryPassed, true)
    assert.equal(outcome.evidenceIds.length, evidence.length)
  } finally {
    item.close()
  }
})

test("a gate whose program is missing is skipped under standard and fails under strict", async () => {
  for (const [strictness, expected] of [
    ["standard", true],
    ["strict", false],
  ] as const) {
    const item = fixture()
    try {
      item.write("src/app.ts", "export const answer = 42\n")
      const workflowId = await freeze(item)

      const { evidence, outcome } = await verifyFixture(item, workflowId, strictness, [
        "definitely-not-a-real-program check",
      ])

      assert.equal(gate(evidence, "command:definitely-not-a-real-program check")?.status, "skipped")
      assert.equal(outcome.mandatoryPassed, expected)
    } finally {
      item.close()
    }
  }
})

// Certification 5.18.
test("the essentiality gate flags a definition the project already has", () => {
  const database = new Database({ path: ":memory:" })
  try {
    const node = (name: string, path: string) => ({
      digest: "d",
      endLine: 10,
      kind: "function",
      language: "typescript",
      name,
      path,
      startLine: 1,
    })
    replaceFile(
      database,
      "p1",
      { digest: "a", indexedAt: 1, language: "typescript", modifiedAt: 0, path: "src/dates.ts", references: [], size: 1 },
      [node("formatDuration", "src/dates.ts")],
    )
    replaceFile(
      database,
      "p1",
      { digest: "b", indexedAt: 1, language: "typescript", modifiedAt: 0, path: "src/new/helpers.ts", references: [], size: 1 },
      [node("formatDuration", "src/new/helpers.ts"), node("Trim", "src/new/helpers.ts")],
    )

    const duplicates = reimplementedCapabilities(database, "p1", [
      { digest: "b", kind: "added", path: "src/new/helpers.ts" },
    ])

    assert.deepEqual(
      duplicates.map((entry) => entry.name),
      ["formatDuration"],
    )
    assert.equal(duplicates[0]?.existsIn, "src/dates.ts")
  } finally {
    database.close()
  }
})

test("a modified file is not a reimplementation of itself", () => {
  const database = new Database({ path: ":memory:" })
  try {
    replaceFile(
      database,
      "p1",
      { digest: "a", indexedAt: 1, language: "typescript", modifiedAt: 0, path: "src/dates.ts", references: [], size: 1 },
      [
        {
          digest: "d",
          endLine: 10,
          kind: "function",
          language: "typescript",
          name: "formatDuration",
          path: "src/dates.ts",
          startLine: 1,
        },
      ],
    )

    const duplicates = reimplementedCapabilities(database, "p1", [
      { digest: "a", kind: "modified", path: "src/dates.ts" },
    ])

    assert.deepEqual(duplicates, [])
  } finally {
    database.close()
  }
})

// `-z` records carry no line breaks, and a rename appends its origin as a second record. Reading
// that origin as a change of its own would double-count every rename in the change set.
test("git status records parse, including renames and their origins", () => {
  const stdout = " M src/app.ts\0?? src/new.ts\0 D src/gone.ts\0R  src/to.ts\0src/from.ts\0"

  assert.deepEqual(parseStatus(stdout), [
    { kind: "modified", path: "src/app.ts" },
    { kind: "added", path: "src/new.ts" },
    { kind: "deleted", path: "src/gone.ts" },
    { kind: "modified", path: "src/to.ts" },
  ])
})

const SNAPSHOT = {
  capturedFlow: "open the banner and tab to the dismiss control",
  nodes: [
    {
      children: [{ children: [], level: null, name: "Dismiss", role: "button" }],
      level: null,
      name: "Main",
      role: "main",
    },
  ],
  url: "http://localhost:3000/",
}

// The interface layer's required gates exist to force the check. A check a reviewer actually ran
// supplies them, and the missing-gate is not inserted on top of it.
test("a captured browser flow satisfies the interface layer", async () => {
  const item = fixture()
  try {
    item.write("src/components/Banner.tsx", "export const Banner = () => null\n")
    const workflowId = await freeze(item)
    submitBrowserEvidence(item.ctx, workflowId, SNAPSHOT, reviewerToken(workflowId))

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "browser:affected-user-flow")?.status, "passed")
    assert.equal(gate(evidence, "accessibility:affected-user-flow")?.status, "passed")
    assert.equal(outcome.mandatoryPassed, true)
  } finally {
    item.close()
  }
})

test("a captured flow with an unnamed control fails the accessibility gate", async () => {
  const item = fixture()
  try {
    item.write("src/components/Banner.tsx", "export const Banner = () => null\n")
    const workflowId = await freeze(item)
    submitBrowserEvidence(item.ctx, workflowId, {
      ...SNAPSHOT,
      nodes: [{ children: [], level: null, name: "", role: "button" }],
    })

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "accessibility:affected-user-flow")?.status, "failed")
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})

test("browser evidence is refused when no candidate is frozen", () => {
  const item = fixture()
  try {
    const started = startWorkflow(item.ctx, "change the fixture", [], "quick") as {
      workflowId: string
    }
    assert.throws(() => submitBrowserEvidence(item.ctx, started.workflowId, SNAPSHOT), /not in quick_execution/u)
  } finally {
    item.close()
  }
})

test("the design detectors record findings for the reviewers without blocking", async () => {
  const item = fixture()
  try {
    item.write("src/theme.css", ".hint { color: #999999; background-color: #ffffff }\n")
    const workflowId = await freeze(item)
    submitBrowserEvidence(item.ctx, workflowId, SNAPSHOT, reviewerToken(workflowId))

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    const design = gate(evidence, "design:detectors")
    assert.equal(design?.status, "failed")
    assert.equal(design?.mandatory, false)
    assert.equal(outcome.mandatoryPassed, true)
  } finally {
    item.close()
  }
})

// The detectors read bytes. Nothing here reaches a model, so a design gate costs no tokens.
test("a change with no interface file records the design gate as passed", async () => {
  const item = fixture()
  try {
    item.write("src/server.ts", "export const port = 8080\n")
    const workflowId = await freeze(item)

    const { evidence } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "design:detectors")?.status, "passed")
  } finally {
    item.close()
  }
})

// A file above the hashing cap was recorded with a null digest, and the integrity comparison read
// two nulls as a match. The bytes of such a file could change completely between freeze and
// verification and the gate still reported that everything matched what was recorded at freeze.
test("a file too large for the old hashing cap is still bound to its bytes", async () => {
  const item = fixture()
  try {
    const big = "a".repeat(9 * 1024 * 1024)
    item.write("assets/large.txt", big)
    const workflowId = await freeze(item)

    item.write("assets/large.txt", "b" + big.slice(1))
    const { evidence, outcome } = await verifyFixture(item, workflowId)

    assert.equal(gate(evidence, "integrity:candidate")?.status, "failed")
    assert.match(gateOutput(item, "integrity:candidate"), /assets\/large\.txt/u)
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})

// The scanner skipped content it could not read, then reported the total number of changed files as
// the number scanned. A file nobody looked at was counted among the files that came back clean.
test("the secret scan does not count a file it skipped as scanned", async () => {
  const item = fixture()
  try {
    item.write("assets/large.txt", "a".repeat(40 * 1024 * 1024))
    item.write("src/app.ts", "export const answer = 42")
    const workflowId = await freeze(item)

    await verifyFixture(item, workflowId)
    const scan = gateOutput(item, "security:changed-content-secrets")

    assert.match(scan, /assets\/large\.txt/u)
    assert.doesNotMatch(scan, /^2 changed files scanned/u)
  } finally {
    item.close()
  }
})

// The gate the interface layer requires was satisfied by an object the executor returned. Nothing
// distinguished a tree it captured from one it wrote, so the party whose work the gate exists to
// check was the party that supplied the proof clearing it.
test("the executor's own capture does not satisfy the interface layer", async () => {
  const item = fixture()
  try {
    item.write("src/components/Banner.tsx", "export const Banner = () => null")
    const workflowId = await freeze(item)
    submitBrowserEvidence(item.ctx, workflowId, SNAPSHOT)

    const { evidence, outcome } = await verifyFixture(item, workflowId)

    // Recorded, and visible to the reviewers, but carrying no weight of its own.
    assert.equal(gate(evidence, "browser:executor-report")?.status, "warning")
    assert.equal(gate(evidence, "browser:executor-report")?.mandatory, false)
    // The layer the change requires is still unproven, so its gate is inserted and fails.
    assert.equal(gate(evidence, "browser:affected-user-flow")?.status, "failed")
    assert.equal(outcome.mandatoryPassed, false)
  } finally {
    item.close()
  }
})
