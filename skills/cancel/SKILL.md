---
name: cancel
description: Cancel the current Cycle workflow. Terminal and confirmed — authorized work in progress is abandoned and no partial candidate is delivered. Use only when the work should not continue at all.
---

Cancel the workflow: $ARGUMENTS

1. Call `cycle-control/workflow` with `{"operation": "status"}` and report what is
   about to be abandoned: the state, the request it was working on, and whether a candidate is
   frozen.
2. **Ask the user to confirm.** Do not call the cancel operation until they answer.
3. On an explicit yes, call
   `{"operation": "control", "controlOperation": "cancel", "confirm": true, "workflowId": "..."}`.
4. Report that the workflow is cancelled and that the record is anchored with a signed checkpoint.

The control plane refuses without `confirm: true`, so a cancellation is never an accident of
phrasing. Cancelling is final: a cancelled workflow accepts nothing further and cannot be resumed.
If the intent is to stop for now, that is `/cycle:pause`.

Nothing in the working tree is reverted. The candidate was never promoted, and whatever the executor
wrote is still there for the user to keep or discard themselves.
