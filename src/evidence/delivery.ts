import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import type { Database, Row } from "../store/database.ts"
import { changedFiles } from "./changes.ts"
import type { CandidateManifest } from "./candidate.ts"
import { gitArgs } from "../git.ts"

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000

export type DeliveryState = "aborted" | "completed" | "prepared" | "written"

export interface DeliveryOutcome {
  readonly committed: boolean
  readonly delivered: readonly string[]
  readonly reason: string
  readonly revision: string
  readonly state: DeliveryState
  readonly verifiedOnly: readonly string[]
}

export class DeliveryAborted extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeliveryAborted"
  }
}

const TEMPORARY_SUFFIX = ".cycle-delivery"

/**
 * Promotion. The bytes that were approved are the bytes that land, and the comparison that decides
 * this runs immediately before the first write: a candidate that moved since approval is not
 * delivered under the approval it no longer matches.
 *
 * Each file is written beside its destination and renamed over it, so no reader ever sees half a
 * file. The journal records the intent before the first rename and the completion after the last,
 * so a control plane killed in between finishes the same delivery instead of starting a new one.
 */
export async function promote(
  database: Database,
  root: string,
  workflowId: string,
  candidateId: string,
  message: string,
  now = Date.now(),
): Promise<DeliveryOutcome> {
  const stored = loadManifest(database, candidateId)
  if (stored === null) throw new DeliveryAborted("this candidate has no recorded manifest")

  // The delivered manifest names the evidence that supported it, so the journal answers
  // "what was this approved on" without a join against a table anyone could add rows to.
  const manifest: CandidateManifest = {
    ...stored,
    evidenceIds: database
      .all<Row>("select id from evidence where candidate_id = ? order by gate_name", candidateId)
      .map((row) => String(row["id"])),
  }

  await assertUnchanged(root, manifest)
  journal(database, workflowId, candidateId, manifest, "prepared", null, now)
  return await write(database, root, workflowId, candidateId, manifest, now, message)
}

/**
 * Finishes a delivery that a crash interrupted. Re-runs the writes, which are idempotent because
 * every one of them is a full file rewritten from the approved bytes.
 */
export async function recoverDelivery(
  database: Database,
  root: string,
  workflowId: string,
  message: string,
  now = Date.now(),
): Promise<DeliveryOutcome | null> {
  const row = database.get<Row>(
    "select * from deliveries where workflow_id = ? and state in ('prepared', 'written')",
    workflowId,
  )
  if (row === undefined) return null

  const candidateId = String(row["candidate_id"])
  const manifest = JSON.parse(String(row["manifest"])) as CandidateManifest
  return await write(database, root, workflowId, candidateId, manifest, now, message)
}

export interface DeliveryRecord {
  readonly candidateId: string
  readonly reason: string | null
  readonly state: DeliveryState
  readonly written: readonly string[]
}

export function deliveryOf(database: Database, workflowId: string): DeliveryRecord | undefined {
  const row = database.get<Row>(
    "select * from deliveries where workflow_id = ? order by updated_at desc limit 1",
    workflowId,
  )
  if (row === undefined) return undefined
  return {
    candidateId: String(row["candidate_id"]),
    reason: (row["reason"] as string | null) ?? null,
    state: String(row["state"]) as DeliveryState,
    written: JSON.parse(String(row["written"])) as string[],
  }
}

async function write(
  database: Database,
  root: string,
  workflowId: string,
  candidateId: string,
  manifest: CandidateManifest,
  now: number,
  message: string,
): Promise<DeliveryOutcome> {
  const payloads = loadPayloads(database, candidateId)
  const delivered: string[] = []
  const verifiedOnly: string[] = []

  for (const file of manifest.files) {
    const target = join(root, ...file.path.split("/"))

    if (file.kind === "deleted") {
      await rm(target, { force: true })
      delivered.push(file.path)
      continue
    }

    const bytes = payloads.get(file.path)
    if (bytes === undefined) {
      // Above the payload cap: the bytes were never kept, so delivery can only confirm that what is
      // on disk is still what was approved. Confirmed, never assumed.
      if ((await digestOf(target)) !== file.digest) {
        throw new DeliveryAborted(
          `${file.path} was too large to keep and no longer matches the approved digest`,
        )
      }
      verifiedOnly.push(file.path)
      continue
    }

    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}${TEMPORARY_SUFFIX}`
    await writeFile(temporary, bytes)
    await rename(temporary, target)
    delivered.push(file.path)

    journal(database, workflowId, candidateId, manifest, "prepared", null, now, delivered)
  }

  journal(database, workflowId, candidateId, manifest, "written", null, now, delivered)

  for (const file of manifest.files) {
    const target = join(root, ...file.path.split("/"))
    const actual = await digestOf(target)
    const expected = file.kind === "deleted" ? null : file.digest
    if (actual !== expected) {
      journal(database, workflowId, candidateId, manifest, "aborted", `${file.path} did not verify after delivery`, now, delivered)
      throw new DeliveryAborted(`${file.path} does not match the approved bytes after delivery`)
    }
  }

  const commit = await commitCandidate(root, manifest, message)
  journal(database, workflowId, candidateId, manifest, "completed", null, now, delivered)
  return {
    committed: commit.committed,
    delivered,
    reason:
      `${delivered.length} files delivered and re-verified, ` +
      `${commit.committed ? "committed as" : "already at"} ${commit.revision.slice(0, 12)}`,
    revision: commit.revision,
    state: "completed",
    verifiedOnly,
  }
}

/**
 * The promotion commit. Hooks are disabled and signing is off, per section 17: a pre-commit hook
 * that reformats would change the bytes an arbiter approved, after they were verified, which is the
 * one thing delivery exists to prevent. The commit records the approved state; the project's own
 * hooks run when the developer pushes, against a tree they can see.
 *
 * Idempotent by construction: if the candidate's paths are already committed, there is nothing to
 * commit and the existing revision is returned, so a recovered delivery does not make a second one.
 */
export async function commitCandidate(
  root: string,
  manifest: CandidateManifest,
  message: string,
): Promise<{ committed: boolean; revision: string }> {
  const paths = manifest.files.map((file) => file.path)
  if (paths.length === 0) throw new DeliveryAborted("there is nothing to commit")

  const pending = await git(root, ["status", "--porcelain=v1", "-z", "--", ...paths])
  if (pending === null) throw new DeliveryAborted("the repository could not be read for the commit")

  if (pending.split("\0").filter(Boolean).length === 0) {
    const head = await git(root, ["rev-parse", "HEAD"])
    if (head === null) throw new DeliveryAborted("the repository has no revision after delivery")
    return { committed: false, revision: head.trim() }
  }

  if ((await git(root, ["add", "--", ...paths])) === null) {
    throw new DeliveryAborted("the delivered files could not be staged")
  }

  const committed = await git(root, [
    "-c",
    "core.hooksPath=",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--only",
    "--no-verify",
    "--message",
    message,
    "--",
    ...paths,
  ])
  if (committed === null) {
    throw new DeliveryAborted(
      "the delivered files could not be committed; the approved bytes are on disk and verified. " +
        "The usual cause is a repository with no user.name or user.email configured.",
    )
  }

  const head = await git(root, ["rev-parse", "HEAD"])
  if (head === null) throw new DeliveryAborted("the commit did not produce a revision")
  return { committed: true, revision: head.trim() }
}

/** What the commit says. The user's own words first, because those are what was judged. */
export function commitMessage(
  request: string,
  manifest: CandidateManifest,
  workflowId: string,
  recordedGates = manifest.evidenceIds.length,
): string {
  const subject = request.trim().split(/\r?\n/u)[0]?.trim() ?? "deliver approved candidate"
  return [
    subject.length > 72 ? `${subject.slice(0, 69)}...` : subject,
    "",
    `Delivered by Cycle against the original request, on ${recordedGates} recorded ` +
      "gates and an independent arbitration.",
    "",
    `Base-revision: ${manifest.baseRevision}`,
    `Candidate-digest: ${manifest.candidateDigest}`,
    `Cycle-workflow: ${workflowId}`,
  ].join("\n")
}

async function git(root: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", gitArgs(root, args), {
      encoding: "utf8",
      maxBuffer: 64 * 1_024 * 1_024,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    return stdout
  } catch {
    return null
  }
}


/** Section 8: the same comparison that guards verification guards promotion. */
async function assertUnchanged(root: string, manifest: CandidateManifest): Promise<void> {
  // The working tree is only half of what the candidate was judged against. A commit landing
  // between approval and promotion leaves every candidate file identical while moving the base out
  // from under it, and the delivered commit would then carry a Base-revision trailer naming a
  // revision that is not its parent. Recovery deliberately does not run this: by then the delivery
  // may already have committed, so HEAD is expected to have moved.
  const head = (await git(root, ["rev-parse", "HEAD"]))?.trim() ?? null
  if (head === null) {
    throw new DeliveryAborted("the base revision could not be read, so the candidate cannot be promoted")
  }
  if (head !== manifest.baseRevision) {
    throw new DeliveryAborted(
      `the base revision moved after approval: judged on ${manifest.baseRevision.slice(0, 12)}, ` +
        `now ${head.slice(0, 12)}`,
    )
  }

  const current = await changedFiles(root)
  if (current === null) {
    throw new DeliveryAborted("the working tree could not be read, so the candidate cannot be compared")
  }

  const approved = new Map(manifest.files.map((file) => [file.path, file]))
  for (const file of current) {
    const match = approved.get(file.path)
    if (match === undefined) {
      throw new DeliveryAborted(`${file.path} changed after approval and is not part of the candidate`)
    }
    if (match.digest !== file.digest) {
      throw new DeliveryAborted(`${file.path} changed after approval`)
    }
  }
}

function journal(
  database: Database,
  workflowId: string,
  candidateId: string,
  manifest: CandidateManifest,
  state: DeliveryState,
  reason: string | null,
  now: number,
  written: readonly string[] = [],
): void {
  database.run(
    `insert into deliveries (candidate_id, workflow_id, state, manifest, written, reason, started_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (candidate_id) do update set
       state = excluded.state, written = excluded.written,
       reason = excluded.reason, updated_at = excluded.updated_at`,
    candidateId,
    workflowId,
    state,
    JSON.stringify(manifest),
    JSON.stringify([...written]),
    reason,
    now,
    now,
  )
}

function loadManifest(database: Database, candidateId: string): CandidateManifest | null {
  const row = database.get<Row>("select manifest from candidates where id = ?", candidateId)
  if (row === undefined) return null
  try {
    const parsed = JSON.parse(String(row["manifest"])) as Partial<CandidateManifest>
    return Array.isArray(parsed.files) ? (parsed as CandidateManifest) : null
  } catch {
    return null
  }
}

function loadPayloads(database: Database, candidateId: string): Map<string, Uint8Array> {
  const rows = database.all<Row>(
    "select path, payload from candidate_files where candidate_id = ? and payload is not null",
    candidateId,
  )
  return new Map(rows.map((row) => [String(row["path"]), row["payload"] as Uint8Array]))
}

async function digestOf(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return createHash("sha256").update(await readFile(path)).digest("hex")
  } catch {
    return null
  }
}
