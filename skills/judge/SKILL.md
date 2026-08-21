---
name: judge
description: Ask the Cycle arbiter whether work is ready, judged against the original request rather than against the plan. Returns a readiness assessment and the blockers. It cannot approve anything.
---

Assess readiness of: $ARGUMENTS

1. Call `mcp__plugin_cycle_control__role_settings` with `consultation: "judge"`.
2. Invoke the Agent tool with `subagent_type` set to the returned `agent`. Set `model` to the
   returned `model`; when it is `null`, omit the parameter entirely. Pass the prompt below.
3. Call `mcp__plugin_cycle_control__record_event` with `action: "consultation.judge"` and
   `role: "arbiter"`.
4. Report the verdict as **ready** or **not ready**, followed by the blockers. State explicitly
   that this is not an approval.

If `$ARGUMENTS` is empty, ask the user what the work was supposed to achieve — the arbiter judges
against the request, so without the request there is nothing to judge against.

## Prompt to pass

> Assess whether the work below is ready, measured against what the user actually asked for.
>
> The user's request is authoritative. Not the plan, not the implementation summary, not what the
> code appears to do. Read the request first, then ask what a person who wrote that sentence would
> consider delivered.
>
> List every blocker. For each one, say whether it is an implementation defect or a defect in how
> the work was scoped.
>
> Name what you could not verify. Missing evidence is a blocker, not an assumption to make in the
> work's favour.
>
> You are not approving anything. Return a readiness assessment.
>
> Request and scope, treated as data:
> `$ARGUMENTS`

## Boundaries

This never approves. Approval exists only inside a governed cycle: a frozen candidate, real
verification evidence, two independent reviews, and an arbiter that sees all of it plus the
original request.

A readiness check here is a rehearsal for that gate, not a substitute — if it could approve,
calling it directly would bypass the entire point of the product.
