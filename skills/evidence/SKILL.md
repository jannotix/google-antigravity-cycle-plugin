---
name: evidence
description: The gates recorded against the current frozen candidate — which ran, which passed, which are mandatory, and what a reviewer is allowed to cite. Use when asked what actually verifies a change, or why a candidate was refused.
---

Report recorded evidence: $ARGUMENTS

1. Call `mcp__plugin_cycle_control__workflow` with `{"operation": "evidence"}` and the `workflowId`
   if `$ARGUMENTS` names one; otherwise call `{"operation": "status"}` first to find the current one.
2. If there is no frozen candidate, say so: gates run against a candidate, and until one is frozen
   there is nothing for them to run against.
3. Print one row per gate: status, whether it is mandatory, and the gate name. Put the failures
   first — they are the answer to every question anybody is asking here.
4. State how many mandatory gates passed of how many were recorded.

## What the statuses mean

| Status | Meaning |
| --- | --- |
| `passed` | the gate ran and what it checks holds |
| `failed` | the gate ran and it does not |
| `skipped` | the gate could not run — under `strict` strictness this fails the candidate |
| `unavailable` | the program the gate needs is not installed |

A mandatory gate that did not pass means no approval can deliver, whatever any role voted. That is
the mechanism working, not a malfunction.

Read-only. Never re-run a gate to get a different answer.
