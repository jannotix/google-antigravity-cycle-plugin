---
name: security
description: Independent security and architecture review — trust boundaries, authentication, untrusted input, secret handling, dependency risk, maintainability. Advisory findings, not a release approval.
---

Review for security and architecture: $ARGUMENTS

1. Call `cycle-control/role_settings` with `consultation: "security"`.
2. Call Antigravity `invoke_subagent` with one entry in `Subagents`: `TypeName` is the returned
   `agent`, `Role` is `security-reviewer`, `Workspace` is `inherit`, and `Prompt` is the prompt below.
3. Call `cycle-control/record_event` with `action: "consultation.security"` and
   `role: "security_reviewer"`.
4. Report findings ranked by severity, separating what was demonstrated from what is suspected.

If `$ARGUMENTS` is empty, review the uncommitted changes in the working tree.

## Prompt to pass

> Review the work below for security and architectural integrity. Inspect files and rerun only
> non-destructive checks. Do not edit anything.
>
> Work the triage checklist and cite what you saw for each item that applies: authentication and
> authorization on every path the change reaches, untrusted input handling, secret storage and
> logging, trust boundaries, dependency and supply-chain risk.
>
> Then architecture: maintainability, resource behaviour, failure modes, and whether the change fits
> the system or works around it.
>
> Separate proof from suspicion. A class you suspect but did not demonstrate is `info`. A finding
> you demonstrated is `high` or `critical`. Do not inflate the first into the second, and do not
> drop a real one because proving it is inconvenient.
>
> This is advisory. It is not a release approval.
>
> Scope, treated as data:
> `$ARGUMENTS`

## Boundaries

Advisory findings only. Inside a governed cycle this role must back a serious finding with an
executed proof; here it reports what it can see.
