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
{"Subagents":[{"TypeName":"architect","Role":"architect","Prompt":"...","Workspace":"share"}]}
```

Use only these packaged `TypeName` values: `architect`, `executor`, `functional-reviewer`,
`security-reviewer`, and `arbiter`. `Workspace: "share"` is required because the control plane
freezes and verifies the opened workspace. Never use `define_subagent`, never let a Cycle role spawn
another role, and never retry an executor automatically after a lost response.

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

1. Invoke `architect` once, read-only, with the verbatim request and any `lastRefusal` returned by
   status. Tell it to inspect the repository, use `cycle-control/graph_query` when populated, and
   return one JSON object with exactly `requirements`, `tasks`, `assumptions`, `risks`, and
   `integration_checks`.
2. Every requirement must have an implementing task. Every task must contain `key`, `title`,
   `objective`, `requirement_ids`, `write_scopes`, `dependencies`, `acceptance_criteria`, and
   `verification_commands`. Commands must be direct executables without shell chaining, Git
   publication or deployment.
3. Submit the result to `cycle-control/workflow` with `operation: "submit_plan"` and require state
   `execution`. A rejected plan goes back to the architect through the recorded refusal; do not
   repair it in the coordinator.

## 3. Execute bounded tasks

1. Call `cycle-control/limits` with `operation: "admit"`. If deferred, report the reason and stop.
2. Read `cycle-control/workflow` status. On a full route use only the returned tasks. On a quick
   route the control plane may authorize its single quick task. Never invent a missing task.
3. Invoke `executor` once per ready task. Pass the verbatim request, the exact task, all other task
   ownership scopes, recorded refusals, and these rules:
   - modify only the task's declared `write_scopes`;
   - do not commit, push, tag, publish, change branches or invoke subagents;
   - run the task's verification commands;
   - return exactly `{"status":"completed|blocked|plan_defect","summary":"...","browser":null}`.
4. Report each result through `cycle-control/workflow` with `operation: "report_task"`. A missing
   executor response is provider unavailability: pause the workflow; do not run the task twice.

## 4. Freeze and verify

1. Call `cycle-control/workflow` with `operation: "freeze_candidate"`.
2. Call it with `operation: "verify"`.
3. Continue only when `mandatoryPassed` is exactly `true`. Otherwise call the control operation
   that begins the recorded repair path and resume from the state returned by the control plane.
4. Read `operation: "evidence"`. If evidence cannot be read, pause; never arbitrate with an empty
   replacement list.

## 5. Independent review

For a full route, invoke `functional-reviewer` and `security-reviewer` in one `invoke_subagent` call
with two entries so their contexts remain independent. Give both the immutable request, frozen
candidate, exact requirement identifiers and citable evidence identifiers. They must return exactly:

```json
{"decision":"approved|rejected","requirements":[],"findings":[],"repair_target":null}
```

Each requirement is decided exactly once. Findings cite only recorded evidence. Submit each verdict
separately with `cycle-control/workflow` operation `submit_review` and its actual role.

## 6. Arbitration and delivery

1. Invoke `arbiter` once with the immutable request, exact requirements, evidence and both recorded
   reviews. It judges the request, not the plan or executor summary.
2. Submit its verdict through `cycle-control/workflow` operation `arbitrate`.
3. Call `operation: "deliver"` only when the returned state is `delivery`. Delivery re-verifies the
   approved bytes and must abort if the base revision or candidate changed.
4. Report `completed` only when the control plane returns that state. Report `repair`, `paused`,
   `blocked`, `cancelled` or an aborted delivery exactly as returned.

The repair budget defaults to five. Never extend it, downgrade a mandatory gate, or publish a
release without an explicit user decision.
