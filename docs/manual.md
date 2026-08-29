# Cycle command manual

All commands are plugin skills under the `cycle` namespace.

| Command | Behaviour |
| --- | --- |
| `/cycle:run [auto\|quick\|full]` | Starts or resumes a governed workflow. `auto` is the default. |
| `/cycle:architect` | Read-only architecture consultation. |
| `/cycle:executor` | Read-only feasibility consultation; it never implements. |
| `/cycle:review` | Independent functional review. |
| `/cycle:security` | Independent security and architecture review. |
| `/cycle:judge` | Readiness rehearsal; it cannot approve delivery. |
| `/cycle:doctor` | Runtime, store, role-tier and policy diagnostics. |
| `/cycle:setup` | First-run setup guidance. |
| `/cycle:status` | Current workflow state, mode, tasks and blockers. |
| `/cycle:tasks` | Accepted task graph and ownership scopes. |
| `/cycle:evidence` | Recorded evidence and requirement mappings. |
| `/cycle:pause` | Pause at a safe state boundary. |
| `/cycle:resume` | Reconcile durable state and continue. |
| `/cycle:retry` | Extend a blocked repair budget after an explicit decision. |
| `/cycle:cancel` | Confirm and cancel the current workflow. |
| `/cycle:index` | Build or query the local semantic graph. |
| `/cycle:memory` | Search, explain or revoke project memory. |
| `/cycle:history` | Verify and query the append-only history. |
| `/cycle:goal` | Manage persistent goals above individual workflows. |
| `/cycle:models` | Show Antigravity tier assignments and correlation warnings. |
| `/cycle:permissions` | Show role tool boundaries and enforcement layers. |
| `/cycle:limits` | Show admission capacity and resource pressure. |
| `/cycle:export` | Confirm and export workflow state and public verification material. |
| `/cycle:help` | Display command guidance. |

## Governed delivery invariant

Only `/cycle:run` can deliver. Advisory commands never approve. A role response is data, not proof.
The control plane accepts an approval only when all requirements are decided, mandatory evidence
passes, independent reviews are recorded where required, and the candidate still matches the frozen
digest at delivery.

## Antigravity limitations

Antigravity offers `inherit`, `flash` and `pro` custom-agent tiers. Cycle does not claim five
different providers. The native host currently supplies role isolation and permission inheritance;
Cycle adds deterministic evidence and delivery checks. Executor subagents use the shared opened
workspace because the long-lived MCP server is scoped to that workspace. Scope reconciliation
detects unauthorized paths before candidate approval.
