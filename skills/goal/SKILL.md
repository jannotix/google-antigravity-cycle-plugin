---
name: goal
description: A persistent objective above individual cycles — versioned plans, milestones that are real evidence-gated workflows, a bounded continuation budget and a completion gate that refuses while anything is unfinished. Use for work that spans more than one change or more than one session.
---

Goal Mode: $ARGUMENTS

Every operation goes to `cycle-control/goal`.

## Starting one

```json
{"operation": "new", "objective": "<the user's own words>",
 "successCriteria": ["...", "..."], "constraints": ["..."], "nonGoals": ["..."]}
```

The objective is **immutable** from this moment. Take it verbatim from the user, exactly as with
`/cycle:run`: it is what completion is judged against, and a paraphrase moves the target.

Success criteria are required. If the user has not given any, ask — do not invent them. "How will
we know this is done?" is the question, and a goal nobody can answer it for is a wish.

A later clarification is `{"operation": "amend", "goalId": "...", "clarification": "..."}`. It is
appended and sequenced; it never rewrites the objective.

## Working it

| Operation | What it does |
| --- | --- |
| `plan` with `content` | saves a new plan version. Without `content`, returns the current one and the version list |
| `link` with `milestone` and `workflowId` | makes an existing workflow a milestone. Omit `workflowId` for a milestone not started yet |
| `status` | the goal, its milestones and their live states, amendments, continuations |
| `list` | every goal in this project, and which one is focused |
| `focus` | make this the project's current goal |
| `pause` / `resume` | stop and return to exactly where it stopped |
| `extend` with `additional` | give a blocked goal more continuations |
| `abort` with `confirm: true` | end it without completing it |

**Milestones link themselves.** Running `/cycle:run` while a goal is focused makes that workflow a
milestone automatically, and delivering it continues the goal. You rarely need `link` by hand.

**Continuations bound the automatic part.** Each delivered milestone spends one; five by default.
Exhausting them moves the goal to `blocked`, which preserves everything and waits for a person.
That is the point — say so plainly rather than extending it on your own initiative.

## Completing one

Two steps, and the first one can refuse:

1. `{"operation": "complete", "goalId": "..."}` — refused while any milestone is incomplete, and
   refused outright if the goal has no milestones. On success the goal moves to `completing` and
   the response returns `judgeAgainst`: the success criteria.
2. Put those criteria in front of the user, one by one, with what was delivered against each. Ask
   whether the goal is met.
3. Only on an explicit yes: `{"operation": "approve", "goalId": "...", "confirm": true}`.

Never call `approve` off your own judgement, and never on a vague "sounds good". The gate is checked
again at approval — a milestone reopened in between refuses it and returns the goal to `active`.

## Boundaries

This is not the native `/goal` command, which is a turn loop scoped to one session. Both can be
used; they do not interact.

Goal Mode does not implement anything. Every milestone is an ordinary governed cycle with its own
evidence, reviews and arbitration, and a goal cannot complete past one that did not.
