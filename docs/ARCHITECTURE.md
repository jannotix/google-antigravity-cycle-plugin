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
evidence for the Antigravity plugin. Their non-shipping workspace remains reproducible through the
tracked `Cargo.lock` and pinned Rust 1.97.0 toolchain.

The root package declares Rust under `cycle.verification.excludeEcosystems`. This prevents the
non-shipping research workspace from being rediscovered as a mandatory gate in every production
TypeScript workflow. Rust can still be tested explicitly; it is not evidence for the v1 plugin.

Role separation has three independent layers:

1. Antigravity custom-agent `tools` allowlists.
2. A native hook that forces user review for high-impact commands.
3. Control-plane reconciliation of task scopes, evidence and frozen candidate bytes.

Antigravity's `invoke_subagent` is asynchronous. Governed role agents therefore persist their own
plan, task report, review or arbitration result through the MCP control plane. The coordinator
dispatches one stage and returns; a later `/cycle:run` reads durable state before advancing. It never
depends on an inline subagent response.

The hook is deliberately not described as an unbypassable sandbox. Antigravity and the user own the
permission decision; delivery correctness is enforced again by the control plane.
