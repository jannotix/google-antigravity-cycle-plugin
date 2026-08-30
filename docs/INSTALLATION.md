# Installation, upgrade and recovery

## Release artifact

Use `cycle-antigravity-<version>.zip` and its matching `.sha256`. Verify the checksum before
extracting. The archive is self-contained and includes `dist/server.js`, parser WASM files, skills,
agents, hook, MCP configuration, licences, documentation, SBOM and lifecycle utility.

## Install with Antigravity

```text
agy plugin validate <unpacked-directory>
agy plugin install <unpacked-directory>
node ~/.gemini/config/plugins/cycle/bin/cycle-lifecycle.mjs activate
agy plugin list
```

`activate` replaces unresolved plugin path placeholders with the absolute installed paths. This is
required on Antigravity CLI 1.1.22. Restart Antigravity, open the target project, then run
`/cycle:doctor`. Confirm `/mcp`, `/hooks`,
`/skills` and `/agents` show Cycle's components.

Interactive use prompts for MCP permission. Headless certification must add only
`mcp(cycle-control/*)` to `permissions.allow`; do not use a global MCP wildcard.

## Recoverable lifecycle utility

`node bin/cycle-lifecycle.mjs activate|install|upgrade|uninstall|rollback` operates inside
`~/.gemini/config`. Existing installed bytes are moved to `cycle-backups` before replacement.
Uninstall is therefore reversible. The utility refuses incomplete trees and symbolic links.

Durable workflow data defaults to `%LOCALAPPDATA%\Cycle` on Windows,
`$XDG_DATA_HOME/cycle` or `~/.local/share/cycle` on Linux, and Application Support on macOS. It is
not removed with the plugin.

## Rollback gate

After upgrade, run `/cycle:doctor` and a read-only status call. If either fails, run rollback before
starting another workflow. Do not reuse verification receipts across source or artifact changes.
