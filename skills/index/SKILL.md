---
name: index
description: Build, refresh or query the project's code graph. Use to see what a change can reach, find where a symbol is defined, or check index freshness. Runs locally with no model calls.
---

Operation requested: $ARGUMENTS

Pick the matching call, run it, and report the result. Do not summarise the graph in prose; report
the numbers and the named symbols.

| Ask | Call |
| --- | --- |
| build, refresh, rebuild, reindex, or `$ARGUMENTS` empty | `mcp__plugin_cycle_control__index_project` |
| status, size, how fresh | `graph_query` with `operation: "status"` |
| where is X defined | `graph_query` with `operation: "symbol"`, `name: "X"` |
| what calls X, what does X use | `graph_query` with `operation: "neighbours"`, `name: "X"` |
| what breaks if I change these files | `graph_query` with `operation: "impact"`, `paths: [...]` |
| give me context for these files | `graph_query` with `operation: "scope"`, `paths: [...]` |

## What the numbers mean

Indexing is incremental by content digest. `unchanged` files were not reparsed — on a large
repository that is the whole point, and a second run reporting `updated: 0` is correct, not a
failure.

`skipped` counts files in a language with no bundled grammar, or larger than the parse limit. They
are still tracked by digest, so they are not invisible; they just contribute no symbols.

## Confidence

Every edge is labelled. `extracted` means the relationship was read from the syntax tree or from a
resolved import. `inferred` means a name matched a single definition elsewhere with no import to
confirm it.

Say which one you are relying on when it matters. An `inferred` edge is a lead, not a fact.

## Boundaries

Read-only. This never modifies the project, and it makes no model calls — parsing runs locally.
