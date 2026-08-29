import { readConfiguration } from "../src/config.ts"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { assertFreezable, captureCandidate, CandidateRefused } from "../src/evidence/candidate.ts"
import {
  commitCandidate,
  commitMessage,
  DeliveryAborted,
  deliveryOf,
  promote,
  recoverDelivery,
} from "../src/evidence/delivery.ts"
import { Database } from "../src/store/database.ts"
import { candidateManifest, recordCandidate } from "../src/store/workflows.ts"
import { latestCheckpoint, verifyCheckpoints } from "../src/store/checkpoints.ts"
import {
  arbitrate,
  deliverCandidate,
  freezeCandidate,
  reconcile,
  startWorkflow,
  verifyCandidate,
  type ServiceContext,
} from "../src/workflow/service.ts"

const MESSAGE = "deliver the fixture change"

interface Fixture {
  readonly close: () => void
  readonly ctx: ServiceContext
  readonly read: (path: string) => string | null
  readonly root: string
  readonly write: (path: string, content: string) => void
}

function fixture(baseline: Record<string, string> = { "README.md": "# fixture\n" }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "cycle-delivery-"))
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
  mkdirSync(join(root, ".githooks-empty"), { recursive: true })
  git("config", "core.hooksPath", join(root, ".githooks-empty"))
  for (const [path, content] of Object.entries(baseline)) write(path, content)
  git("add", "-A")
  git("commit", "--quiet", "-m", "baseline")

  const database = new Database({ path: ":memory:" })
  const data = mkdtempSync(join(tmpdir(), "cycle-delivery-data-"))
  return {
    close: () => {
      database.close()
      rmSync(root, { force: true, recursive: true })
      rmSync(data, { force: true, recursive: true })
    },
    ctx: { configuration: readConfiguration({}), database, dataDirectory: data, maxRepairCycles: 5, projectId: "p1" },
    read: (path) => {
      try {
        return readFileSync(join(root, path), "utf8")
      } catch {
        return null
      }
    },
    root,
    write,
  }
}

async function frozen(item: Fixture): Promise<{ candidateId: string; workflowId: string }> {
  const started = startWorkflow(item.ctx, "change the fixture", [], "quick") as {
    workflowId: string
  }
  const result = freezeCandidate(
    item.ctx,
    started.workflowId,
    await captureCandidate(item.root),
  ) as { candidateId: string }
  return { candidateId: result.candidateId, workflowId: started.workflowId }
}

test("the manifest records the base revision, the diff and what the project builds against", async () => {
  const item = fixture({ "README.md": "# fixture\n", "package.json": '{"name":"x"}\n' })
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId } = await frozen(item)

    const manifest = candidateManifest(item.ctx.database, candidateId)!
    assert.match(manifest.baseRevision, /^[0-9a-f]{40}$/u)
    assert.match(manifest.diffDigest, /^[0-9a-f]{64}$/u)
    assert.match(manifest.dependencyStateDigest, /^[0-9a-f]{64}$/u)
    assert.match(manifest.configurationDigest, /^[0-9a-f]{64}$/u)
    assert.match(manifest.environmentDigest, /^[0-9a-f]{64}$/u)
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["src/app.ts"],
    )
  } finally {
    item.close()
  }
})

// Two freezes of the same bytes must agree, or nothing downstream can compare anything.
test("the candidate digest is stable across two captures of the same bytes", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const first = await captureCandidate(item.root)
    const second = await captureCandidate(item.root)

    assert.equal(first.manifest.candidateDigest, second.manifest.candidateDigest)
  } finally {
    item.close()
  }
})

test("a repository mid-merge or with no commit cannot be frozen", async () => {
  const empty = mkdtempSync(join(tmpdir(), "cycle-unborn-"))
  try {
    execFileSync("git", ["-C", empty, "init", "--quiet"], { stdio: "ignore" })
    await assert.rejects(() => assertFreezable(empty), CandidateRefused)
  } finally {
    rmSync(empty, { force: true, recursive: true })
  }

  const item = fixture()
  try {
    writeFileSync(join(item.root, ".git", "MERGE_HEAD"), "deadbeef\n")
    await assert.rejects(() => assertFreezable(item.root), /mid-operation/u)
  } finally {
    item.close()
  }

  const loose = mkdtempSync(join(tmpdir(), "cycle-nogit-"))
  try {
    await assert.rejects(() => assertFreezable(loose), /not a git repository/u)
  } finally {
    rmSync(loose, { force: true, recursive: true })
  }
})

test("promotion writes the approved bytes and re-verifies them", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)

    const outcome = await promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE)

    assert.deepEqual(outcome.delivered, ["src/app.ts"])
    assert.equal(outcome.state, "completed")
    assert.equal(item.read("src/app.ts"), "export const answer = 42\n")
    assert.equal(deliveryOf(item.ctx.database, workflowId)?.state, "completed")
  } finally {
    item.close()
  }
})

// Certification 7.2. Overwriting someone's edit with older approved bytes is worse than stopping.
test("a candidate changed after approval aborts before anything is written", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 41\n")
    const { candidateId, workflowId } = await frozen(item)
    item.write("src/app.ts", "export const answer = 42\n")

    await assert.rejects(
      () => promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE),
      /changed after approval/u,
    )
    assert.equal(item.read("src/app.ts"), "export const answer = 42\n")
    assert.equal(deliveryOf(item.ctx.database, workflowId), undefined)
  } finally {
    item.close()
  }
})

test("a file that appeared after approval aborts the delivery", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)
    item.write("src/extra.ts", "export const sneaky = true\n")

    await assert.rejects(
      () => promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE),
      /not part of the candidate/u,
    )
  } finally {
    item.close()
  }
})

// Certification 7.3 in its hardest form: the change was lost, and delivery puts back exactly what
// was approved rather than declaring success over an empty tree.
test("a candidate file deleted after approval is restored from the approved bytes", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)
    rmSync(join(item.root, "src", "app.ts"))

    const outcome = await promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE)

    assert.equal(outcome.state, "completed")
    assert.equal(item.read("src/app.ts"), "export const answer = 42\n")
  } finally {
    item.close()
  }
})

test("a candidate that deletes a file delivers the deletion", async () => {
  const item = fixture({ "README.md": "# fixture\n", "src/old.ts": "export const gone = 1\n" })
  try {
    rmSync(join(item.root, "src", "old.ts"))
    const { candidateId, workflowId } = await frozen(item)

    await promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE)

    assert.equal(existsSync(join(item.root, "src", "old.ts")), false)
  } finally {
    item.close()
  }
})

// Certification 7.4. The journal is what makes a killed delivery finishable rather than guessable.
test("a delivery interrupted after the journal was written is recovered", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)

    // Exactly what a crash between "prepared" and the first rename leaves behind.
    const manifest = candidateManifest(item.ctx.database, candidateId)!
    item.ctx.database.run(
      `insert into deliveries (candidate_id, workflow_id, state, manifest, written, started_at, updated_at)
       values (?, ?, 'prepared', ?, '[]', 1, 1)`,
      candidateId,
      workflowId,
      JSON.stringify(manifest),
    )
    rmSync(join(item.root, "src", "app.ts"))

    const recovered = await recoverDelivery(item.ctx.database, item.root, workflowId, MESSAGE)

    assert.equal(recovered?.state, "completed")
    assert.equal(item.read("src/app.ts"), "export const answer = 42\n")
  } finally {
    item.close()
  }
})

test("there is nothing to recover when no delivery was interrupted", async () => {
  const item = fixture()
  try {
    const { workflowId } = await frozen(item)

    assert.equal(await recoverDelivery(item.ctx.database, item.root, workflowId, MESSAGE), null)
  } finally {
    item.close()
  }
})

test("a candidate with no recorded manifest cannot be delivered", async () => {
  const item = fixture()
  try {
    const { workflowId } = await frozen(item)
    recordCandidate(item.ctx.database, workflowId, "made-up", {
      manifest: {
        baseRevision: "0".repeat(40),
        candidateDigest: "d",
        configurationDigest: "c",
        dependencyStateDigest: "p",
        diffDigest: "f",
        environmentDigest: "e",
        evidenceIds: [],
        files: [],
      },
      payloads: new Map(),
    }, 1)
    item.ctx.database.run("update candidates set manifest = '' where id = 'made-up'")

    await assert.rejects(
      () => promote(item.ctx.database, item.root, workflowId, "made-up", MESSAGE),
      DeliveryAborted,
    )
  } finally {
    item.close()
  }
})

// Certification 4.7 and 7.4 together: the application was closed mid-delivery, and a fresh session
// reattaches, finishes what was approved, and says where it is.
test("reconciliation finishes a delivery the application interrupted", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)

    verifyCandidate(item.ctx, workflowId, {
      evidenceIds: [],
      mandatoryPassed: true,
      reason: "gates passed",
    })
    arbitrate(
      item.ctx,
      workflowId,
      { decision: "approved", findings: [], repair_target: null, requirements: [] },
      true,
    )

    const manifest = candidateManifest(item.ctx.database, candidateId)!
    item.ctx.database.run(
      `insert into deliveries (candidate_id, workflow_id, state, manifest, written, started_at, updated_at)
       values (?, ?, 'prepared', ?, '[]', 1, 1)`,
      candidateId,
      workflowId,
      JSON.stringify(manifest),
    )
    rmSync(join(item.root, "src", "app.ts"))

    const reconciled = (await reconcile(item.ctx, item.root)) as {
      recovered: { delivered: string[] } | null
      state: string
    }

    assert.deepEqual(reconciled.recovered?.delivered, ["src/app.ts"])
    assert.equal(reconciled.state, "completed")
    assert.equal(item.read("src/app.ts"), "export const answer = 42\n")
  } finally {
    item.close()
  }
})

test("delivery through the service moves the workflow to completed and signs the chain", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { workflowId } = await frozen(item)

    verifyCandidate(item.ctx, workflowId, {
      evidenceIds: [],
      mandatoryPassed: true,
      reason: "gates passed",
    })
    arbitrate(
      item.ctx,
      workflowId,
      { decision: "approved", findings: [], repair_target: null, requirements: [] },
      true,
    )

    const delivered = (await deliverCandidate(item.ctx, workflowId, item.root)) as {
      delivered: string[]
      state: string
    }

    assert.equal(delivered.state, "completed")
    assert.deepEqual(delivered.delivered, ["src/app.ts"])
    assert.equal(verifyCheckpoints(item.ctx.database).valid, true)
    assert.ok(latestCheckpoint(item.ctx.database) !== undefined)
  } finally {
    item.close()
  }
})

// A delivery that aborts must leave the workflow in delivery, not claim it completed.
test("an aborted delivery does not move the workflow", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 41\n")
    const { workflowId } = await frozen(item)

    verifyCandidate(item.ctx, workflowId, {
      evidenceIds: [],
      mandatoryPassed: true,
      reason: "gates passed",
    })
    arbitrate(
      item.ctx,
      workflowId,
      { decision: "approved", findings: [], repair_target: null, requirements: [] },
      true,
    )
    item.write("src/app.ts", "export const answer = 42\n")

    const result = (await deliverCandidate(item.ctx, workflowId, item.root)) as {
      aborted: string
      state: string
    }

    assert.match(result.aborted, /changed after approval/u)
    assert.equal(result.state, "delivery")
    assert.equal(item.read("src/app.ts"), "export const answer = 42\n")
  } finally {
    item.close()
  }
})

const show = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

// Delivery commits the approved change: the working tree is clean afterwards and HEAD moved.
test("delivery commits the approved bytes", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const before = show(item.root, "rev-parse", "HEAD")
    const { candidateId, workflowId } = await frozen(item)

    const outcome = await promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE)

    assert.equal(outcome.committed, true)
    assert.match(outcome.revision, /^[0-9a-f]{40}$/u)
    assert.notEqual(outcome.revision, before)
    assert.equal(show(item.root, "status", "--porcelain"), "")
    assert.equal(show(item.root, "show", "--name-only", "--format=", "HEAD"), "src/app.ts")
  } finally {
    item.close()
  }
})

test("the commit message leads with the request and records what was approved", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)
    const manifest = candidateManifest(item.ctx.database, candidateId)!

    await promote(
      item.ctx.database,
      item.root,
      workflowId,
      candidateId,
      commitMessage("add the answer endpoint", manifest, workflowId),
    )
    const message = show(item.root, "log", "-1", "--format=%B")

    assert.ok(message.startsWith("add the answer endpoint"))
    assert.ok(message.includes(`Base-revision: ${manifest.baseRevision}`))
    assert.ok(message.includes(`Candidate-digest: ${manifest.candidateDigest}`))
    assert.ok(message.includes(`Cycle-workflow: ${workflowId}`))
  } finally {
    item.close()
  }
})

// Section 17. A pre-commit hook that reformats would change bytes an arbiter approved, after they
// were verified — which is the one thing delivery exists to prevent.
test("a repository hook cannot rewrite or refuse the delivered bytes", async () => {
  const item = fixture()
  try {
    const hooks = join(item.root, ".githooks-empty")
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)

    const outcome = await promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE)

    assert.equal(outcome.committed, true)
    assert.equal(show(item.root, "status", "--porcelain"), "")
  } finally {
    item.close()
  }
})

// A recovered delivery must not produce a second commit for the same candidate.
test("a delivery already committed is recognised rather than committed twice", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)

    const first = await promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE)
    const again = await recoverDelivery(item.ctx.database, item.root, workflowId, MESSAGE)

    assert.equal(again, null, "a completed delivery is not re-run")
    assert.equal(show(item.root, "rev-list", "--count", "HEAD"), "2")
    assert.equal(first.committed, true)
  } finally {
    item.close()
  }
})

test("a commit that cannot be made is reported, not swallowed", async () => {
  const loose = mkdtempSync(join(tmpdir(), "cycle-nogit-commit-"))
  try {
    await assert.rejects(
      () =>
        commitCandidate(
          loose,
          {
            baseRevision: "0".repeat(40),
            candidateDigest: "d",
            configurationDigest: "c",
            dependencyStateDigest: "p",
            diffDigest: "f",
            environmentDigest: "e",
            evidenceIds: [],
            files: [{ digest: "x", kind: "added", path: "src/app.ts" }],
          },
          MESSAGE,
        ),
      /could not be read for the commit/u,
    )
  } finally {
    rmSync(loose, { force: true, recursive: true })
  }
})

// The approved bytes are written and verified before the commit is attempted, so a commit that
// fails leaves the work on disk rather than losing it.
test("a candidate with nothing to commit is refused", async () => {
  const item = fixture()
  try {
    await assert.rejects(
      () =>
        commitCandidate(
          item.root,
          {
            baseRevision: "0".repeat(40),
            candidateDigest: "d",
            configurationDigest: "c",
            dependencyStateDigest: "p",
            diffDigest: "f",
            environmentDigest: "e",
            evidenceIds: [],
            files: [],
          },
          MESSAGE,
        ),
      /nothing to commit/u,
    )
  } finally {
    item.close()
  }
})

// The manifest records the revision the candidate was built and judged on, and the delivered commit
// states it in a trailer. Nothing compared it again: only the working tree was checked, so a commit
// landing between approval and promotion moved the base out from under an arbitrated candidate and
// the trailer named a parent that was no longer the parent.
test("a base revision that moved after approval aborts the delivery", async () => {
  const item = fixture()
  try {
    item.write("src/app.ts", "export const answer = 42\n")
    const { candidateId, workflowId } = await frozen(item)

    // An unrelated commit: the candidate's own files are untouched, so the working-tree comparison
    // still matches and only the base has changed.
    item.write("NOTES.md", "unrelated\n")
    execFileSync("git", ["-C", item.root, "add", "NOTES.md"], { stdio: "ignore" })
    execFileSync("git", ["-C", item.root, "commit", "--quiet", "-m", "unrelated"], { stdio: "ignore" })

    await assert.rejects(
      () => promote(item.ctx.database, item.root, workflowId, candidateId, MESSAGE),
      /base revision/u,
    )
    assert.equal(deliveryOf(item.ctx.database, workflowId), undefined)
  } finally {
    item.close()
  }
})
