---
name: run
description: Runs the complete governed Cycle using Antigravity native subagents, deterministic verification, independent reviews and fail-closed delivery. Use when the user wants a requested change implemented rather than discussed.
---

# Governed Cycle

Run Cycle for: $ARGUMENTS

The TypeScript control plane is authoritative. Call its tools on MCP server `cycle-control`; in the
tool picker they are identified as `cycle-control/<tool>`. Never invent a state, identifier, task,
requirement or evidence record. When a required call or subagent result is missing, pause and report
the missing evidence.

Write every prose sentence in the language of the immutable original request. Do not translate the
structured values: decisions, statuses, requirement identifiers, task keys, gate names and JSON
field names remain exactly as specified because the control plane validates them.

## Native Antigravity contract

Invoke a packaged role with `invoke_subagent`:

```json
{"Subagents":[{"TypeName":"architect","Role":"architect","Prompt":"...","Workspace":"inherit"}]}
```

Use only these packaged `TypeName` values: `architect`, `executor`, `functional-reviewer`,
`security-reviewer`, and `arbiter`. `Workspace: "inherit"` is required so native file tools operate
inside the active project rather than an internal `.gemini` worktree. The control plane still
freezes and verifies the opened workspace. Never use `define_subagent`, never let a Cycle role spawn
another role, and never retry an executor automatically after a lost response.

Antigravity subagents are asynchronous: `invoke_subagent` starts background work and returns without
the role's final payload. Never say that you will wait inside the same turn and never expect JSON to
come back inline. Every governed role receives the exact `workflowId` and reports its own result to
`cycle-control/workflow`. After dispatch, tell the user which role is running and end the turn. A
later `/cycle:run` reads persisted state and continues the next stage.

Before dispatching, call `manage_subagents` with `Action: "list"`. If the same governed role is still
`running` or `idle` and workflow state has not advanced, do not invoke a duplicate. Report the role
and state. After an interrupted application session, run reconciliation first; a role whose outcome
cannot be observed is provider unavailability, not permission to run it twice.

## 1. Start and route

1. Preserve the user's request verbatim. If `$ARGUMENTS` is empty, use the most recent user request
   exactly as written.
2. Call `cycle-control/workflow` with:

   ```json
   {"operation":"start","request":"<verbatim request>","preference":"auto"}
   ```

   Use `quick` or `full` only when the user explicitly selected it.
3. Require a `workflowId`. Then call `cycle-control/workflow` with `operation: "status"` and that
   identifier. The status response, not a prior summary, decides the next stage.
4. Call `cycle-control/graph_query` with `operation: "status"`. A zero-file graph is uninitialized;
   roles must inspect the repository directly rather than trust an empty graph.

## 2. Architecture for a full route

When state is `architecture`:

1. Invoke `architect` once, read-only, with the exact `workflowId`, verbatim request and any
   `lastRefusal` returned by status. Tell it to inspect the repository, use
   `cycle-control/graph_query` when populated, and build one JSON object with exactly `requirements`,
   `tasks`, `assumptions`, `risks`, and `integration_checks`.
2. Every requirement must have an implementing task. Every task must contain `key`, `title`,
   `objective`, `requirement_ids`, `write_scopes`, `dependencies`, `acceptance_criteria`, and
   `verification_commands`. Commands must be direct executables without shell chaining, Git
   publication or deployment.
3. Tell the architect to submit that plan itself with `operation: "submit_plan"`. End the turn after
   dispatch. A rejected plan goes back through the recorded refusal; do not repair it in the
   coordinator.

## 3. Execute bounded tasks

1. Read `cycle-control/workflow` status. On a full route use only the returned tasks. Never invent a
   missing task. If every full-route task is complete, continue directly to freeze and verify.
2. Call `cycle-control/limits` with `operation: "admit"`. If deferred, report the reason and stop.
3. Invoke `executor` once per ready full-route task, or once for the quick route. Pass the exact
   `workflowId`, route, verbatim request, exact task when present, all other task ownership scopes,
   recorded refusals, and these rules:
   - modify only the task's declared `write_scopes`;
   - treat the assigned inherited workspace as the project and edit only with native file tools;
     never use `run_command` or shell redirection to write files;
   - do not commit, push, tag, publish, change branches or invoke subagents;
   - leave task verification commands to the Cycle control plane; the executor has no terminal;
   - on a full route, report itself through `operation: "report_task"`;
   - on a successful quick route, freeze the candidate, submit any browser self-report, and call
     `operation: "verify"` itself.
4. End the turn after dispatch. A missing state transition is provider unavailability: pause the
   workflow; do not run the task twice.

## 4. Freeze and verify

1. Call `cycle-control/workflow` with `operation: "freeze_candidate"`.
2. Call it with `operation: "verify"`.
3. Continue only when `mandatoryPassed` is exactly `true`. Otherwise call the control operation
   that begins the recorded repair path and resume from the state returned by the control plane.
4. Read `operation: "evidence"`. If evidence or its `frozenCandidate` is missing, pause; never
   arbitrate with an empty replacement list. Pass the returned `frozenCandidate` object verbatim to
   every reviewer and the arbiter; their Antigravity worktrees may contain only the base revision.

## 5. Independent review

For a full route, invoke `functional-reviewer` and `security-reviewer` in one `invoke_subagent` call
with two entries so their contexts remain independent. Give both the exact `workflowId`, immutable
request, frozen candidate, exact requirement identifiers and citable evidence identifiers. They
must form exactly:

```json
{"decision":"approved|rejected","requirements":[],"findings":[],"repair_target":null}
```

Each requirement is decided exactly once. Findings cite only recorded evidence. Each reviewer
submits its own verdict with `operation: "submit_review"` and its actual role. End the turn after
dispatch; a later `/cycle:run` continues only after both persisted reviews exist.

## 6. Arbitration and delivery

1. In `arbitration`, invoke `arbiter` once with the exact `workflowId`, immutable request, exact
   requirements, evidence and both recorded reviews. It judges the request, not the plan or executor
   summary, and submits its own verdict through `operation: "arbitrate"`. End the turn.
2. On a later `/cycle:run`, call `operation: "deliver"` only when persisted state is `delivery`.
   Delivery re-verifies the
   approved bytes and must abort if the base revision or candidate changed.
3. Report `completed` only when the control plane returns that state. Report `repair`, `paused`,
   `blocked`, `cancelled` or an aborted delivery exactly as returned.

The repair budget defaults to five. Never extend it, downgrade a mandatory gate, or publish a
release without an explicit user decision.
