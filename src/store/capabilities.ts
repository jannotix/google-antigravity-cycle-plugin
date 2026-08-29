import { randomBytes } from "node:crypto"

import type { Database, Row } from "./database.ts"
import { DIGEST_DOMAIN, digest } from "./ids.ts"

/** The roles that may prove the interface layer. The executor is not one of them, by construction. */
export const CAPTURING_ROLES = ["functional_reviewer", "security_reviewer"] as const

export type CapturingRole = (typeof CAPTURING_ROLES)[number]

export interface CaptureCapability {
  readonly role: CapturingRole
  /** Returned once, at issue. Only its digest is kept, so a stolen store yields nothing usable. */
  readonly token: string
}

/**
 * Mints one secret per reviewing role for this candidate. Over stdio the plane cannot tell who is
 * calling — it reads a line — so a submission that names its own role is a claim, and the party the
 * gate exists to check can make it. Holding a secret the plane issued to one role and delivered
 * only to that role is something the executor cannot do: the secrets are minted after its work is
 * frozen, and no agent can read another's prompt.
 *
 * Re-issuing for the same candidate returns nothing new: a capability that could be re-minted on
 * demand would be no capability at all.
 */
export function issueCaptureCapabilities(
  database: Database,
  workflowId: string,
  candidateId: string,
  now: number,
): CaptureCapability[] {
  const issued: CaptureCapability[] = []
  for (const role of CAPTURING_ROLES) {
    const existing = database.get<Row>(
      "select digest from capture_capabilities where candidate_id = ? and role = ?",
      candidateId,
      role,
    )
    if (existing !== undefined) continue

    const token = randomBytes(24).toString("base64url")
    database.run(
      `insert into capture_capabilities (digest, workflow_id, candidate_id, role, issued_at)
       values (?, ?, ?, ?, ?)`,
      digest(DIGEST_DOMAIN.captureCapability, token),
      workflowId,
      candidateId,
      role,
      now,
    )
    issued.push({ role, token })
  }
  return issued
}

export type Redemption =
  | { readonly reason: "consumed" | "unknown" | "wrong_candidate"; readonly role: null }
  | { readonly reason: null; readonly role: CapturingRole }

/**
 * Spends one capability and reports which role held it. The role is read from the record and never
 * from the caller, which is the whole point: a claim is not a credential.
 */
export function redeemCaptureCapability(
  database: Database,
  candidateId: string,
  token: string,
  now: number,
): Redemption {
  const row = database.get<Row>(
    "select candidate_id, consumed_at, role from capture_capabilities where digest = ?",
    digest(DIGEST_DOMAIN.captureCapability, token),
  )
  if (row === undefined) return { reason: "unknown", role: null }
  if (String(row["candidate_id"]) !== candidateId) return { reason: "wrong_candidate", role: null }
  if (row["consumed_at"] !== null) return { reason: "consumed", role: null }

  database.run(
    "update capture_capabilities set consumed_at = ? where digest = ?",
    now,
    digest(DIGEST_DOMAIN.captureCapability, token),
  )
  return { reason: null, role: row["role"] as CapturingRole }
}
