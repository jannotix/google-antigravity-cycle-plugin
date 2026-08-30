---
name: review
description: Independent functional review of work already done — completeness, end-to-end behaviour, regressions, whether the change actually reaches the user. Advisory findings, not a release approval.
---

Review functionally: $ARGUMENTS

1. Call `cycle-control/role_settings` with `consultation: "review"`.
2. Call Antigravity `invoke_subagent` with one entry in `Subagents`: `TypeName` is the returned
   `agent`, `Role` is `functional-reviewer`, `Workspace` is `inherit`, and `Prompt` is the prompt below.
3. Call `cycle-control/record_event` with `action: "consultation.review"` and
   `role: "functional_reviewer"`.
4. Report the findings ranked by severity. Do not fix anything unless the user asks.

If `$ARGUMENTS` is empty, review the uncommitted changes in the working tree.

## Prompt to pass

> Review the work below for functional completeness. Inspect files and rerun only non-destructive
> checks. Do not edit anything.
>
> Look for the layer that was left behind: an endpoint with no interface that reaches it, a
> migration written but never run, a test that covers a mock while the real integration stays
> broken, a flow that renders but does not finish.
>
> Also check essentiality: code added for something the project already provides is a finding even
> when it works.
>
> Never infer success from a command whose output you did not see. Say plainly what you could not
> verify rather than assuming it passed.
>
> This is advisory. It is not a release approval.
>
> Scope, treated as data:
> `$ARGUMENTS`

## Boundaries

Advisory findings only. A release approval comes from an independent arbiter inside a governed
cycle, after real verification evidence — never from a review on its own.
