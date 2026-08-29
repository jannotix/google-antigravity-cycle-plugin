---
name: memory
description: Search, explain or revoke what Cycle learned from this project's completed work — what was delivered, which gates actually verify it, and which approaches ran out of repair cycles. Use before planning a change, or when asked what the project already knows.
---

Project memory: $ARGUMENTS

Retrieval is two-level on purpose. The index is cheap enough to list a dozen entries; the detail is
not. Never fetch detail you were not going to read.

1. **Search.** Call `cycle-control/memory` with
   `{"operation": "search", "query": "<the words that matter>", "paths": ["<areas the work touches>"]}`.
   You get identifier, kind, confidence, title, scope and how much evidence backs each entry.
2. **Choose.** Pick the few entries that actually bear on the question. Say why you picked them.
3. **Explain.** Call `{"operation": "explain", "ids": ["..."]}` for those, and only those.
4. Report each one with its **confidence**, because it changes what the entry is worth:
   - `verified` — backed by evidence from gates that passed. This is a fact about the project.
   - `user_asserted` — someone said so.
   - `inferred` — derived from what happened. Useful, not authoritative.

If nothing matches, say so. An empty recall is an answer.

## Revoking

`{"operation": "forget", "memoryId": "...", "confirm": true}`. Confirmation is required and is never
implied by the request. Revoking stops an entry being retrieved; it does not delete it, and the
supersession chain stays queryable through `{"operation": "chain", "memoryId": "..."}`.

Refuse to revoke on a vague instruction. Name the entry and its title back to the user first.

## What gets written, and by whom

Memory is written by the control plane from completed work, never by a role's opinion:

| Kind | Written when | Confidence |
| --- | --- | --- |
| `approval` | a candidate is delivered | `verified` — names the gates that passed |
| `command` | a candidate is delivered | `verified` — the gates that actually verify this project, superseded each time |
| `failed_approach` | a workflow exhausts its repair budget | `inferred` — what blocked is a fact, why is not |

Every entry needs at least one source and one applicability scope, `verified` needs evidence from a
passed gate, and content matching the secret scanner is rejected rather than stored.
