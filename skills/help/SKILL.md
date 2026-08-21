---
name: help
description: The complete Cycle command reference — what each command does, which are automatic, and which need confirmation. Use when asked what Cycle can do, which command fits a situation, or what a command will change.
---

Cycle command reference: $ARGUMENTS

If `$ARGUMENTS` names a command, report that row and its confirmation requirement only. Otherwise
print the whole table, grouped as below, and nothing else.

Every operation runs automatically when its preconditions are met. These commands exist for
inspection, control, recovery and expert use.

**Running work**

| Command | What it does |
| --- | --- |
| `/cycle:run [auto\|quick\|full]` | Run the governed cycle on a change |
| `/cycle:goal` | A persistent objective across several cycles, with a completion gate |

**Watching it**

| Command | What it does |
| --- | --- |
| `/cycle:status` | State, route, repair budget, and why it is standing still if it is |
| `/cycle:tasks` | The task breakdown and the write scopes each task may touch |
| `/cycle:evidence` | The gates recorded against the frozen candidate |
| `/cycle:history [verify]` | The append-only record, or its chain and signature verification |
| `/cycle:memory` | What the project learned from delivered work, and what it stopped believing |

**Controlling it**

| Command | What it does |
| --- | --- |
| `/cycle:pause` | Stop at the next safe boundary, keeping all state |
| `/cycle:resume` | Reconcile after a restart and continue from where it stopped |
| `/cycle:retry` | Extend the repair budget of a blocked workflow |
| `/cycle:cancel` | Abandon the workflow. Terminal, and asks first |

**Asking a role on its own** — all advisory, none can approve or deliver

| Command | What it does |
| --- | --- |
| `/cycle:architect` | Plan a change. Read-only, multi-turn |
| `/cycle:executor` | Feasibility: scopes, dependencies, verification needs. Never writes |
| `/cycle:review` | Independent functional review of work already done |
| `/cycle:security` | Independent security and architecture review |
| `/cycle:judge` | Readiness against the original request. Never approves |

**Inspecting the installation**

| Command | What it does |
| --- | --- |
| `/cycle:setup` | First-run check and what is worth configuring |
| `/cycle:doctor` | Runtime, storage, store, and anything that silently changes how a run behaves |
| `/cycle:models` | What each role runs on, which provider carries it, and what pays |
| `/cycle:permissions` | The immutable boundaries between the roles |
| `/cycle:limits` | What Cycle may take from this machine, and why something is waiting |
| `/cycle:index` | Build, refresh or query the code graph. Local, no model calls |
| `/cycle:export` | Export state, history or evidence. Asks first |
| `/cycle:help` | This reference |

## What to say when someone asks where to start

`/cycle:run` on a small, real change. Everything else exists for when that run does something the
user wants to understand or interrupt.

Three commands ask for confirmation before they act: `/cycle:cancel`, `/cycle:export`, and
`/cycle:memory` when revoking an entry. Completing a goal asks twice.

The full manual is `docs/manual.md` in the plugin directory. Point at it only if the user wants more
than the one line each command gets here.
