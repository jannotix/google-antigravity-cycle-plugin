import { createHash, type Hash } from "node:crypto"

import { DIGEST_DOMAIN } from "../store/ids.ts"

/**
 * Streaming variant of the store's output digest. A gate's output is retained only up to the cap,
 * but the digest covers every byte it printed, so a truncated record still commits to the whole
 * thing and cannot be quietly edited into a shorter, friendlier one.
 */
export function outputHash(): Hash {
  return createHash("sha256").update(Buffer.from(DIGEST_DOMAIN.output, "utf8"))
}

export function outputDigest(text: string): string {
  return outputHash().update(Buffer.from(text, "utf8")).digest("hex")
}
