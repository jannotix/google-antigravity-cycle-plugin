# Production architecture

Antigravity discovers plugin metadata, 24 skills, seven custom agents, one MCP server and one hook.
The MCP server is a dependency-free Node process using stdio JSON-RPC. It owns SQLite state,
candidate digests, verification plans, evidence, history, memory and delivery.

The source bundle keeps Antigravity-native `${extensionPath}` entrypoints. Antigravity CLI 1.1.22
does not expand them when importing the plugin, so the lifecycle `activate` step materializes the
installed MCP and hook entrypoints to absolute paths. The installed MCP declaration also contains
an explicit `enabledTools` list. This is deterministic installation state, not a second control
plane; `dist/server.js` remains the only workflow runtime.

Store startup performs SQLite `quick_check`. A corrupt store is rejected by the persistence layer,
while the server remains alive long enough for `cycle_doctor` to return an actionable failure instead
of terminating the MCP process.

Rust crates are not part of the supported runtime or artifact. They are retained only as research
until moved to a separate project; production CI and documentation must not cite their tests as
evidence for the Antigravity plugin.

Role separation has three independent layers:

1. Antigravity custom-agent `tools` allowlists.
2. A native hook that forces user review for high-impact commands.
3. Control-plane reconciliation of task scopes, evidence and frozen candidate bytes.

The hook is deliberately not described as an unbypassable sandbox. Antigravity and the user own the
permission decision; delivery correctness is enforced again by the control plane.
