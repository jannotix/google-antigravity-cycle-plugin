---
name: pause
description: Stop the current Cycle workflow at the next safe boundary, keeping all state. Use when the machine is needed for something else, or when work should stop without being thrown away.
---

Pause the workflow: $ARGUMENTS

1. Call `cycle-control/workflow` with `{"operation": "status"}` to find the workflow if
   `$ARGUMENTS` does not name one.
2. Call `{"operation": "control", "controlOperation": "pause", "workflowId": "..."}`.
3. Report the returned `state`, and say that `/cycle:resume` returns it to exactly where it stopped.

Verification and delivery cannot be paused, and the refusal says so. That is deliberate: a gate
interrupted half way proves nothing, and a delivery interrupted half way is the one state the
journal exists to finish rather than suspend. Wait for the boundary; it is seconds away.

A paused workflow holds no admission slot, so pausing gives the machine back to whatever else needs
it. Nothing in the working tree is touched.
