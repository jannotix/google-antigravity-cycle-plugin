---
name: retry
description: Extend the repair budget of a blocked Cycle workflow by one cycle so it can continue. Use when a run stopped because the repairs ran out and the next attempt is worth making.
---

Retry a blocked workflow: $ARGUMENTS

1. Call `cycle-control/workflow` with `{"operation": "status"}` to find the workflow
   and confirm it is `blocked`.
2. If it is not blocked, say what state it is in and what continues it — `/cycle:run` for a run in
   progress, `/cycle:resume` for a paused one. Do not extend a budget nothing is waiting on.
3. Otherwise call `{"operation": "control", "controlOperation": "retry", "workflowId": "..."}` and
   report the returned state and the new budget.

## Before extending it

A workflow blocks after its repair budget is spent on the same candidate. Say what rejected it last
— the arbiter's refusal, a reviewer's finding, or a mandatory gate that did not pass — and ask
whether anything has changed that makes the next attempt different from the last one. Extending the
budget on an approach that has already failed five times spends model time to reach the same verdict.

The record is preserved either way. `/cycle:memory` shows what the project learned from the blocked
approach, which is the thing worth having if the answer is to try something else instead.
