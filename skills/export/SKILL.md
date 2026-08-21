---
name: export
description: Export this project's Cycle record — workflow state, the append-only history with its chain verification, or the evidence recorded against a candidate. Confirmed, read-only, never automatic. Use for an audit, a handover or an incident review.
---

Export the record: $ARGUMENTS

1. Decide the kind from `$ARGUMENTS`: `state` (the current workflow, its plan, tasks and reviews),
   `history` (the append-only chain and its verification) or `evidence` (the gates recorded against
   the frozen candidate). Default to `state` and say which you chose.
2. **Ask the user to confirm**, saying what will be produced and where it will go. Export is never
   automatic.
3. On an explicit yes, call `mcp__plugin_cycle_control__workflow` with
   `{"operation": "export", "kind": "...", "confirm": true}`, adding `workflowId` if one was named.
4. Write the returned JSON to the file the user named, with the Write tool. If they named none, ask
   where it should go — do not print thousands of lines into the conversation.

## What the export is worth

A `history` export carries its own chain verification. If `chain.valid` is false, say so
prominently in whatever is handed over: an exported record that does not verify is evidence of
tampering, not a record.

History exports are capped, and `truncated` says when there was more than the export carried. A
capped export that did not say so would be worse than no export.

Nothing is redacted at export time because nothing secret was ever written — secrets are scanned and
redacted before they reach the chain or memory.

Read-only. Exporting changes no state and no file inside the project.
