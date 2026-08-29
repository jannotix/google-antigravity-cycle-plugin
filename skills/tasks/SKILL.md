---
name: tasks
description: The task breakdown of the current Cycle workflow — identifiers, titles, states and the write scopes each task is authorized to touch. Use to see what the architect decomposed the work into, or which task is stuck.
---

Report the task graph: $ARGUMENTS

1. Call `cycle-control/workflow` with `{"operation": "status"}`, passing `workflowId`
   only if `$ARGUMENTS` names one.
2. If `tasks` is empty, say the workflow has no task breakdown — the quick route has no architect
   and therefore no task graph — and report the state instead.
3. Otherwise print one row per task: key, state, title, and write scopes.

## What the write scopes are

They are what the architect authorized that task to modify, and they are enforced rather than
suggested: after each task the control plane reads the worktree itself and rejects the task if any
changed path falls outside them. A task left `blocked` after reporting completion changed something
no scope covered, and the answer names the paths.

Report and stop. Do not start, repair or re-plan anything.
