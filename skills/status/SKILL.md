---
name: status
description: Where the current Cycle workflow is — state, route, candidate, repair budget, and why it is standing still if it is. Use when asked how the run is going, or before deciding whether to resume, retry or cancel.
---

Report workflow state: $ARGUMENTS

1. Call `cycle-control/workflow` with `{"operation": "status"}`. Pass `workflowId`
   only if `$ARGUMENTS` names one; otherwise the latest workflow in this project is reported.
2. If `found` is false, say there is no workflow in this project and stop.
3. Report, in this order:
   - **`state`** and **`mode`** — where it is and which route it took
   - **`pausedBecause`**, if it is not null — say it verbatim, before anything else about the state
   - **`repair`** — cycles used of the budget
   - **`tasks`** — how many are completed of how many, and the key of the first that is not
   - whether a candidate is frozen

Do not re-run the cycle, and do not poll. This reports; the user decides.

## What the states mean

| State | What is happening |
| --- | --- |
| `architecture` · `execution` · `verification` | the run is working; `/cycle:run` continues it |
| `independent_reviews` · `arbitration` | the candidate is frozen and being judged |
| `delivery` | promotion is in progress, or was interrupted — `/cycle:resume` finishes it |
| `repair` | something rejected the candidate; another cycle is running |
| `paused` | stopped at a safe boundary; `pausedBecause` says why |
| `blocked` | the repair budget ran out; `/cycle:retry` extends it |
| `completed` · `cancelled` | terminal |

If `historyAltered` appears on the answer, say so first and stop: the project record no longer
verifies, and nothing should be run against it until `/cycle:history verify` explains why.
