# Claude Code comparison

The mature Claude Code variant supplied the host-neutral TypeScript control plane, strict compiler
profile, behavioral suite, parser runtime, packaging allowlist, ZIP writer, SBOM process and CI
shape. These components are retained where their public behavior is independent of the host.

Claude-specific components were not copied as contracts:

| Claude Code capability | Antigravity implementation |
| --- | --- |
| `.claude-plugin/plugin.json` | strict native `plugin.json` |
| `.mcp.json` and `CLAUDE_PLUGIN_ROOT` | `mcp_config.json` and `${extensionPath}` |
| `disallowedTools` | explicit native `tools` allowlists |
| `Agent` tool and `subagent_type` | `invoke_subagent` with `TypeName` |
| executable JavaScript plugin workflow | fail-closed `run` skill orchestrating native subagents |
| arbitrary model identifier/gateway claims | supported `inherit`, `flash`, `pro` tiers only |
| Claude hook payload and output | Antigravity `toolCall` and `decision` contract |

Antigravity plugin policy does not expose Claude's executable workflow runtime. The run skill is
therefore more dependent on the host coordinator, while the control plane remains authoritative for
every state transition and refuses missing evidence.
