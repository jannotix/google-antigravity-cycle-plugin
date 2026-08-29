---
name: resume
description: Reconcile a Cycle workflow after the application restarted or a run was interrupted, and report where it stopped and what happens next. Finishes a delivery a crash left half done.
---

Reconcile and report: $ARGUMENTS

1. Call `cycle-control/workflow` with `{"operation": "reconcile"}`. Pass
   `workflowId` only if `$ARGUMENTS` names one; otherwise the latest workflow in this project is
   reconciled.
2. Report the returned `state`, the repair budget, and the `next` line **verbatim**. It says what
   has to happen, and guessing something else is how a half-delivered candidate gets re-run.
3. If `recovered` is not null, say how many files a delivery interrupted by a crash finished
   writing.
4. If `pausedBecause` is not null, say it verbatim before anything else about the state. A workflow
   paused because a provider stopped answering is waiting on the provider, not on the user, and the
   reason names which role lost it.
5. If `chain` is false, say so plainly and stop: the project history no longer verifies, and
   nothing should be run against it until `/cycle:history verify` explains why.

Do not re-run the cycle yourself. Reconciliation reports; the user decides.

## What the states mean

| State | What happened |
| --- | --- |
| `completed` | The candidate was delivered and re-verified. Nothing to resume |
| `delivery` | Promotion was interrupted and could not be finished. The working tree needs a look |
| `repair` | A gate, a reviewer or the arbiter rejected the candidate. `/cycle:run` continues it |
| `blocked` | The repair budget ran out. All work is preserved; `/cycle:retry` extends it |
| `paused` | Stopped at a safe boundary — deliberately, or because a provider stopped answering. `pausedBecause` says which. `/cycle:resume` returns it to where it stopped |
| anything else | The run stopped mid-stage. `/cycle:run` picks it up from the persisted state |

## Boundaries

Reconciliation never approves, never delivers and never edits. It reads persisted state, finishes a
delivery that was already approved and interrupted, and tells you where you are.
