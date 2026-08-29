---
name: models
description: Which model and which provider each Cycle role actually runs on, what pays for each request, and how independent the five verdicts really are. Use before trusting a review, after changing model configuration, or when setting up a gateway for per-role providers.
---

Role models and provider paths: $ARGUMENTS

1. Call `cycle-control/doctor`.
2. Report `report.models.roles` as a table: role, configured model, resolved model, effort,
   provider, and what is billed. One row per role, no prose between rows.
3. Then report, in one line each:
   - `report.models.distinctProviders` out of five, and `report.models.distinctRoleModels`
   - the endpoint from `report.models.baseUrlHost`, or that the session is on the default Anthropic
     API when it is null
4. State every finding whose code starts with `models.` verbatim. Add nothing to them.

If `$ARGUMENTS` names a role, report that role's row and its findings only.

## What independence means here

Five roles running on one model are one opinion recorded five times. The structure still holds — the
executor cannot approve its own work — but correlated errors are far more likely than three separate
verdicts suggest. `distinctProviders` is the honest number: providers, not model names, because two
names served by the same model behind a gateway are not two providers.

The plugin names a model per role. What answers is the user's own infrastructure.

## Assigning a model

Cycle **cannot** change this configuration, and does not try: role models come from the
configuration file `~/.gemini/config/cycle/config.json` or `.agents/cycle.json`. To change one, the user opens
the configuration file and sets the model for that role:

| Role | JSON Key | Environment Variable |
| --- | --- | --- |
| architect | `models.architect` | `ANTIGRAVITY_CYCLE_OPTION_ARCHITECT_MODEL` |
| executor | `models.executor` | `ANTIGRAVITY_CYCLE_OPTION_EXECUTOR_MODEL` |
| functional reviewer | `models.functional_reviewer` | `ANTIGRAVITY_CYCLE_OPTION_FUNCTIONAL_REVIEWER_MODEL` |
| security reviewer | `models.security_reviewer` | `ANTIGRAVITY_CYCLE_OPTION_SECURITY_REVIEWER_MODEL` |
| arbiter | `models.arbiter` | `ANTIGRAVITY_CYCLE_OPTION_ARBITER_MODEL` |
| operator | `models.operator` | `ANTIGRAVITY_CYCLE_OPTION_OPERATOR_MODEL` |

`inherit` follows the session model. Any other value is passed to the role as its model.

For **independent providers** (e.g. Qwen, GLM, OpenAI, Claude, local Ollama), configure API keys in
`~/.gemini/config/cycle/credentials.json` or standard environment variables.

Say what to set and why. Do not offer to set it automatically without user consent, and never log
credentials: Cycle never exposes private keys.

## Boundaries

Read-only. This command reports configuration and never changes it, never starts a workflow, and
never recommends a specific commercial model — the user decides what answers.
