# Production architecture

Antigravity discovers plugin metadata, 24 skills, seven custom agents, one MCP server and one hook.
The MCP server is a dependency-free Node process using stdio JSON-RPC. It owns SQLite state,
candidate digests, verification plans, evidence, history, memory and delivery.

Rust crates are not part of the supported runtime or artifact. They are retained only as research
until moved to a separate project; production CI and documentation must not cite their tests as
evidence for the Antigravity plugin.

Role separation has three independent layers:

1. Antigravity custom-agent `tools` allowlists.
2. A native hook that forces user review for high-impact commands.
3. Control-plane reconciliation of task scopes, evidence and frozen candidate bytes.

The hook is deliberately not described as an unbypassable sandbox. Antigravity and the user own the
permission decision; delivery correctness is enforced again by the control plane.
