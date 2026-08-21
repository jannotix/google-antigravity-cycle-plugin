---
name: run
description: Run the governed cycle on a change — architect, executor, two independent reviewers, and an arbiter that judges against your original request. Use when you want the change built and verified, not discussed.
---

Run the cycle for: $ARGUMENTS

1. Take the user's request **verbatim**. If `$ARGUMENTS` is empty, use their most recent message
   word for word. Never paraphrase, summarise or tidy it: the arbiter judges the delivered work
   against this exact text, and every word you change is a requirement you silently rewrote.
2. Call `mcp__plugin_cycle_control__role_settings` once per role — `architect`, `executor`,
   `review`, `security`, `judge` — and build the model map. Omit any role whose `model` is null.
3. Run the `/cycle:run` workflow, passing `args`:

```json
{
  "request": "<the exact text>",
  "preference": "auto",
  "models": { "architect": "...", "executor": "...", "functional-reviewer": "...", "security-reviewer": "...", "arbiter": "...", "operator": "..." },
  "efforts": { "architect": "...", "executor": "...", "functional-reviewer": "...", "security-reviewer": "...", "arbiter": "..." }
}
```

Use `preference: "quick"` only if the user explicitly asked for the quick route, `"full"` if they
asked for the full one, otherwise `"auto"` and let the routing decide.

4. Report the returned state once, and stop. The run continues in the background; do not poll it.
   `/cycle:status` reports progress when the user asks.

## What the states mean

| State | What happened |
| --- | --- |
| `completed` | The candidate was approved and delivered |
| `blocked` | The repair budget ran out. All work is preserved; `/cycle:retry` extends it |
| `repair` | A gate, a reviewer or the arbiter rejected the candidate; another cycle is running |
| `cancelled` | The user stopped it |
| `paused` | A safe boundary. If the result carries `failure: "provider_unavailable"`, the named role's provider stopped answering after the runtime had retried; nothing was rejected and no repair cycle was spent. `/cycle:resume` continues it once the provider is back |

If the result carries a `refusal`, say it plainly: the arbiter voted to approve and the control
plane refused because the mandatory gates had not passed. That is the gate working. An approval
that is not backed by evidence never becomes a delivery.

## Boundaries

Do not implement anything yourself, before or after the run. Do not re-run the cycle because the
first result was not what you expected — read the state, and report it.
