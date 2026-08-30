# Cycle for Antigravity

<p align="center">
  <img src="assets/logo.svg" width="160" alt="Cycle logo">
</p>

Cycle is an evidence-gated delivery control plane for Google Antigravity Desktop and CLI. It uses
five packaged custom agents—architect, executor, functional reviewer, security reviewer and
arbiter—while a deterministic local Node control plane owns workflow state, verification evidence,
candidate freezing and delivery.

## Production architecture

Version 1.1 uses one control plane: TypeScript on Node 24 LTS. Rust `workflowd` sources remain in the
repository as non-shipping research and are excluded from the artifact, CI runtime and support
contract. No feature depends on Rust, Cargo or a native binary.

Antigravity supplies role isolation through custom-agent tool allowlists. Read-only roles receive no
write, command or delegation tools. The executor receives only the tools needed to implement and
verify one bounded task. A native `PreToolUse` hook forces explicit user approval for publication,
history-changing Git operations and recursive deletion. The control plane independently rejects
out-of-scope changes and refuses delivery without passed mandatory gates.

## Requirements

- Google Antigravity CLI 1.1.22 or newer, or the corresponding Antigravity Desktop runtime.
- Node.js 24.20.x LTS. The exact development version is recorded in `.node-version`.
- Git 2.30 or newer.
- The target project's own build and test tools.

Antigravity exposes the native `inherit`, `flash` and `pro` model tiers. Cycle does not claim
arbitrary external-provider routing on this host. Roles are separate sessions even when tiers are
shared; `/cycle:doctor` reports correlation honestly.

## Install

Use the unpacked release artifact, not a source snapshot without `dist/`:

```text
agy plugin validate C:\path\to\cycle-antigravity-1.1.0
agy plugin install C:\path\to\cycle-antigravity-1.1.0
node %USERPROFILE%\.gemini\config\plugins\cycle\bin\cycle-lifecycle.mjs activate
```

Then restart Antigravity and run:

```text
/cycle:doctor
```

`activate` materialises the installed absolute MCP and hook paths required by Antigravity CLI
1.1.22. Interactive sessions can approve Cycle's MCP tools when prompted. For headless use, add the
scoped allow rule `mcp(cycle-control/*)`; Cycle never adds it silently.

For subsequent recoverable local lifecycle operations:

```text
node bin/cycle-lifecycle.mjs upgrade --source C:\path\to\new-artifact
node bin/cycle-lifecycle.mjs uninstall
node bin/cycle-lifecycle.mjs rollback
```

Upgrade and uninstall move the previous plugin into `~/.gemini/config/cycle-backups`; they do not
delete it. Durable Cycle state is stored outside the plugin installation and survives all four
operations.

## Commands

| Command | Purpose |
| --- | --- |
| `/cycle:run [auto\|quick\|full]` | Execute the governed workflow |
| `/cycle:doctor` | Check runtime, storage, roles and policy |
| `/cycle:status` | Show workflow state and blockers |
| `/cycle:tasks` | Show accepted task ownership and state |
| `/cycle:evidence` | Show citable verification evidence |
| `/cycle:pause`, `/cycle:resume`, `/cycle:retry`, `/cycle:cancel` | Control recovery |
| `/cycle:architect`, `/cycle:executor`, `/cycle:review`, `/cycle:security`, `/cycle:judge` | Advisory isolated roles |
| `/cycle:index`, `/cycle:memory`, `/cycle:history`, `/cycle:goal` | Local intelligence and durable governance |
| `/cycle:models`, `/cycle:permissions`, `/cycle:limits`, `/cycle:export`, `/cycle:help` | Inspect configuration and controls |

The full command contract is in [docs/manual.md](docs/manual.md). Installation and rollback details
are in [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Development gates

```text
npm ci
npm run typecheck
npm run build
npm test
npm run validate:plugin
npm run sbom
npm run package
```

`npm run check` executes the complete deterministic sequence. Platform and credentialed
certification remain separate because CI cannot honestly prove a live Antigravity multi-agent run
without an authenticated host.

## License and status

FSL-1.1-MIT. See `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`.

The earlier public `v1.0.0` is not a supported production artifact. It is not retagged or rewritten.
Cycle is independent and is not affiliated with, sponsored by or endorsed by Google.
