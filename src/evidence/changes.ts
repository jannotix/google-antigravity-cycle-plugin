import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { gitArgs } from "../git.ts"

const execFileAsync = promisify(execFile)

/**
 * The scanner reads a file into memory to run patterns over it, so it needs a bound. Hashing does
 * not: it streams, and a cap there would leave a file recorded with no digest, which the integrity
 * comparison then had to treat as either a match or a mystery.
 */
const MAX_SCAN_BYTES = 32 * 1_024 * 1_024
const GIT_TIMEOUT_MS = 30_000

export type ChangeKind = "added" | "deleted" | "modified"

export interface ChangedFile {
  /** null only when the file could not be read at all, which is drift, never a match. */
  readonly digest: string | null
  readonly kind: ChangeKind
  readonly path: string
}

/**
 * The candidate is everything the executor changed and has not committed: git's own working-tree
 * status, which already applies the project's ignore rules. Returns null when the change set cannot
 * be determined at all, which the engine turns into a failed integrity gate rather than an empty
 * change set — an unknown candidate must never verify as a clean one.
 */
export async function changedFiles(root: string): Promise<ChangedFile[] | null> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      "git",
      gitArgs(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      { encoding: "utf8", maxBuffer: 64 * 1_024 * 1_024, shell: false, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    ))
  } catch {
    return null
  }

  const entries = parseStatus(stdout)
  const files: ChangedFile[] = []
  for (const entry of entries) {
    files.push({ ...entry, digest: await digestOf(join(root, entry.path)) })
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * `-z` records are `XY <path>\0`, and a rename or copy appends its origin as a second record. The
 * origin is dropped: the candidate is the state on disk now, and the new path is what carries it.
 */
export function parseStatus(stdout: string): { kind: ChangeKind; path: string }[] {
  const records = stdout.split("\0")
  const entries: { kind: ChangeKind; path: string }[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length < 4) continue

    const status = record.slice(0, 2)
    const path = record.slice(3).replaceAll("\\", "/")
    if (!path) continue
    // A rename or copy carries its origin in the next record, which is not a change of its own.
    if (status.includes("R") || status.includes("C")) index += 1

    entries.push({ kind: kindOf(status), path })
  }

  return entries
}

function kindOf(status: string): ChangeKind {
  if (status === "??" || status.includes("A") || status.includes("C")) return "added"
  if (status.includes("D")) return "deleted"
  return "modified"
}

/** null when the content cannot be scanned, which the caller must report rather than absorb. */
export async function readChangedContent(root: string, path: string): Promise<string | null> {
  try {
    const bytes = await readFile(join(root, path))
    return bytes.byteLength > MAX_SCAN_BYTES ? null : bytes.toString("utf8")
  } catch {
    return null
  }
}

/** Streamed, so size is not a reason for a candidate file to go unbound to its bytes. */
async function digestOf(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256")
    await pipeline(createReadStream(path), hash)
    return hash.digest("hex")
  } catch {
    return null
  }
}
