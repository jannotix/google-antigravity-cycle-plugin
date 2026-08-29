---
name: history
description: Read the project's append-only history, or verify its hash chain and Ed25519 checkpoint signatures. Use when asked what happened, who did it, or whether the record can still be trusted.
---

Read or verify the project history: $ARGUMENTS

1. Call `cycle-control/workflow` with `{"operation": "history", "limit": 50}`. Pass
   `after` to page forward from a sequence number.
2. Report `chain` and `signatures` **first**, before any entry. A record that does not verify is not
   a record.
   - `chain.valid: false` names the sequence where the hash stopped matching and why: `sequence` for
     a gap, `link` for a broken predecessor, `hash` for edited content.
   - `signatures.valid: false` means `detached` — the chain was rewritten under a signature valid
     for different bytes — or `signature`, meaning the signature itself does not verify.
3. Then list the entries: sequence, action, actor, role and workflow. Cap at what was asked for.

If either verification fails, say what failed and where, and say plainly that the history has been
altered since it was written. Do not soften it, and do not offer to repair it: an append-only record
that can be repaired is not one.

## What is recorded

Every workflow transition, every architecture decision, every task outcome, every candidate freeze
with its base revision and digest, every verification result, every review and arbitration verdict,
every security proof, and every delivery. Secrets are redacted before an entry is written.

Each entry commits to its predecessor. Checkpoints are signed with a key that lives in the plugin
data directory with restricted permissions and never leaves it.
