---
name: permissions
description: The immutable boundaries between the Cycle roles — who may write, who may only read, who may approve, and the three independent layers that enforce it. Use when asked what a role can do, or whether a boundary can be relaxed.
---

Report the role boundaries: $ARGUMENTS

1. Call `mcp__plugin_cycle_control__permissions`.
2. Print one row per role from `boundaries`: the role, whether it writes, what it may do, and the
   tools it is denied.
3. State the three `enforcement` layers, each on its own line, verbatim.
4. Close with the `invariant`, verbatim.

If `$ARGUMENTS` names a role, report that row and the enforcement layers only.

## The question people actually ask

They ask whether a boundary can be turned off for this one case. It cannot. There is no setting, no
flag and no argument that lets a read-only role write, lets the executor approve its own work, or
lets an approval deliver past a mandatory gate that did not pass. A product whose separation of
powers has a setting has no separation of powers: the boundary would be off exactly when somebody
was in a hurry, which is when it matters.

What *is* configurable is which model each role runs on, how hard it thinks, how strict the gates
are, and how many repair cycles a workflow gets. `/cycle:models` and `/cycle:limits` report those.

Read-only. This command reports boundaries and cannot change them, because nothing can.
