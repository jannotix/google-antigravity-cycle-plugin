import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Database, Row } from "./database.ts"
import { DIGEST_DOMAIN } from "./ids.ts"

const KEY_DIRECTORY = "keys"
const KEY_FILE = "checkpoint.key"

export interface Checkpoint {
  readonly createdAt: number
  readonly hash: string
  readonly publicKey: string
  readonly sequence: number
  readonly signature: string
}

export class SigningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SigningError"
  }
}

/**
 * The signing key is generated once, on first use, and never leaves the data directory. Permissions
 * are restricted at creation: 0600 on POSIX, and on Windows an ACL granting the current user alone,
 * because a file everyone can read is a signature anyone can forge.
 */
export function signingKey(dataDirectory: string): { privatePem: string; publicPem: string } {
  const directory = join(dataDirectory, KEY_DIRECTORY)
  const path = join(directory, KEY_FILE)

  let privatePem: string
  try {
    privatePem = readFileSync(path, "utf8")
  } catch {
    mkdirSync(directory, { recursive: true })
    const pair = generateKeyPairSync("ed25519")
    privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    writeFileSync(path, privatePem, { encoding: "utf8", mode: 0o600 })
    restrict(path)
  }

  const privateKey = createPrivateKey(privatePem)
  return {
    privatePem,
    publicPem: createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
  }
}

const ICACLS_TIMEOUT_MS = 5_000

function restrict(path: string): void {
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600)
    } catch {
      // A filesystem without POSIX modes cannot be tightened; keyPermissions still reports it.
    }
    return
  }

  // Synchronously, and this is the whole point: an asynchronous call here can lose the race with
  // process exit, and the key then keeps whatever the temp directory's inherited ACL granted —
  // which on a shared machine is several accounts with Modify. Failure is not fatal, because
  // keyPermissions reports what the file actually carries rather than what this tried to set.
  const account = principal()
  if (account === null) return
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${account}:F`], {
      shell: false,
      stdio: "ignore",
      timeout: ICACLS_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch {
    // Reported, not thrown: a key that exists and is loose is better than no key and no history.
  }
}

function principal(): string | null {
  const user = process.env["USERNAME"]?.trim()
  if (!user) return null
  const domain = process.env["USERDOMAIN"]?.trim()
  return domain ? `${domain}\\${user}` : user
}

export interface KeyPermissions {
  readonly detail: string
  readonly exists: boolean
  readonly restricted: boolean
}

/**
 * What the key file actually carries now, rather than what creation attempted. A signature is worth
 * the exclusivity of the key that made it, so this is read from the filesystem every time doctor
 * runs and not cached from the moment it was written.
 */
export function keyPermissions(dataDirectory: string): KeyPermissions {
  const path = join(dataDirectory, KEY_DIRECTORY, KEY_FILE)

  if (process.platform !== "win32") {
    try {
      const mode = statSync(path).mode & 0o777
      return {
        detail: `0${mode.toString(8)}`,
        exists: true,
        restricted: (mode & 0o077) === 0,
      }
    } catch {
      return { detail: "no key yet", exists: false, restricted: true }
    }
  }

  let acl: string
  try {
    // stderr is discarded explicitly: without it Node forwards it to the parent, and on a data
    // directory with no key yet icacls writes a not-found line into the server's own stream.
    acl = execFileSync("icacls", [path], {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: ICACLS_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch {
    return { detail: "no key yet", exists: false, restricted: true }
  }

  // icacls prints `path principal:(rights)` and then one indented principal per line. Inherited
  // entries carry (I), and an inherited entry is exactly the state this is here to catch.
  const inherited = acl.includes("(I)")
  const principals = [...acl.matchAll(/([^\s:]+):\((?!I\))/gu)].length
  return {
    detail: inherited ? "inherited access is still granted" : `${principals} principal(s)`,
    exists: true,
    restricted: !inherited && principals <= 1,
  }
}

/** Signs the current head of the chain. Idempotent: signing the same sequence twice replaces it. */
export function signCheckpoint(
  database: Database,
  dataDirectory: string,
  now = Date.now(),
): Checkpoint | null {
  const head = database.get<{ hash: string; sequence: number }>(
    "select hash, sequence from history order by sequence desc limit 1",
  )
  if (head === undefined) return null

  const { privatePem, publicPem } = signingKey(dataDirectory)
  const signature = sign(null, payload(head.sequence, head.hash), createPrivateKey(privatePem))
    .toString("base64")

  database.run(
    `insert into checkpoints (sequence, hash, signature, public_key, created_at)
     values (?, ?, ?, ?, ?)
     on conflict (sequence) do update set
       hash = excluded.hash, signature = excluded.signature,
       public_key = excluded.public_key, created_at = excluded.created_at`,
    head.sequence,
    head.hash,
    signature,
    publicPem,
    now,
  )

  return { createdAt: now, hash: head.hash, publicKey: publicPem, sequence: head.sequence, signature }
}

export function latestCheckpoint(database: Database): Checkpoint | undefined {
  const row = database.get<Row>("select * from checkpoints order by sequence desc limit 1")
  return row === undefined ? undefined : toCheckpoint(row)
}

export type CheckpointVerification =
  | { readonly checked: number; readonly head: number | null; readonly valid: true }
  | { readonly reason: "detached" | "signature"; readonly sequence: number; readonly valid: false }

/**
 * Every checkpoint must still sign the hash the chain holds at that sequence. A `detached` failure
 * means the chain was rewritten under a signature that was valid for different bytes.
 */
export function verifyCheckpoints(database: Database): CheckpointVerification {
  const rows = database.all<Row>("select * from checkpoints order by sequence")
  let head: number | null = null

  for (const row of rows) {
    const checkpoint = toCheckpoint(row)
    const entry = database.get<{ hash: string }>(
      "select hash from history where sequence = ?",
      checkpoint.sequence,
    )
    if (entry === undefined || entry.hash !== checkpoint.hash) {
      return { reason: "detached", sequence: checkpoint.sequence, valid: false }
    }

    let ok = false
    try {
      ok = verify(
        null,
        payload(checkpoint.sequence, checkpoint.hash),
        createPublicKey(checkpoint.publicKey),
        Buffer.from(checkpoint.signature, "base64"),
      )
    } catch {
      ok = false
    }
    if (!ok) return { reason: "signature", sequence: checkpoint.sequence, valid: false }
    head = checkpoint.sequence
  }

  return { checked: rows.length, head, valid: true }
}

function payload(sequence: number, hash: string): Buffer {
  return Buffer.from(`${DIGEST_DOMAIN.historyEntry}/checkpoint/${sequence}/${hash}`, "utf8")
}

function toCheckpoint(row: Row): Checkpoint {
  return {
    createdAt: Number(row["created_at"]),
    hash: String(row["hash"]),
    publicKey: String(row["public_key"]),
    sequence: Number(row["sequence"]),
    signature: String(row["signature"]),
  }
}
