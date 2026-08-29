---
name: limits
description: What Cycle is allowed to take from this machine, what the machine has right now, and why a workflow is waiting instead of running. Use when work is deferred, or before starting several cycles at once.
---

Admission and resource governance: $ARGUMENTS

1. Call `cycle-control/limits` with `{"operation": "status"}`.
2. Report, in this order:
   - **`pressure`** — if it is not null, this is the answer. Say it verbatim: it names the reserve
     that was breached, or says the metrics could not be read.
   - **`resources`** against **`reserves`** — available memory, available disk, CPU load, and the
     thresholds each is measured against.
   - **`share`** — how many slots this project holds of how many it is owed, and `limits.maxActive`
     for the machine as a whole.
   - **`active`** — the leases in force, with the project each belongs to.

## What the numbers mean

The reserves are what the machine **keeps**, not what Cycle may use. Available memory below 1 GiB,
available disk below 2 GiB or CPU above 85 % defers new work; so does a metric that could not be
read at all, because "unknown" must never be treated as "healthy".

Slots are leased for fifteen seconds and renewed every five. A session that dies renews nothing, so
its slot returns on its own — nothing has to notice that it went.

Each project is owed a fair share of the slots: with two projects contending on four slots, neither
takes more than two. A project working alone uses all of them.

After a pressured reading, admissions are throttled while the machine recovers, so it is not
immediately refilled by whatever was waiting.

## When something is deferred

A deferral is not an error and not a queue. The reason says what would have to change, and
`renewWithinSeconds` says how soon it is worth asking again. Report the reason and stop — do not
retry in a loop, and do not raise the limits to get past it. If the user wants more concurrency, the
honest answer is that the machine is the constraint.

## Boundaries

The control plane governs how many workflows are active; it does not execute them. Antigravity's
own concurrency limits apply to the agent sessions that run the roles, and how many sessions run is the user's choice.
