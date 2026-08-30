# Changelog

## [1.1.0] - Unreleased

### Changed

- Made the Node/TypeScript control plane the sole production runtime; Rust is excluded from the v1 artifact.
- Converted the plugin to Antigravity-native `plugin.json`, `mcp_config.json`, `hooks.json`, custom-agent frontmatter and `invoke_subagent` workflows.
- Added strict TypeScript settings, behavioral tests, vendored parser runtime, reproducible packaging and a CycloneDX SBOM.
- Added recoverable install, upgrade, uninstall and rollback operations.
- Materialized MCP and hook entrypoints to absolute installed paths during lifecycle activation and
  declared the complete MCP tool allowlist required by Antigravity CLI 1.1.22.
- Kept MCP diagnostics available when an existing Cycle SQLite store fails its integrity check.
- Restricted model configuration to Antigravity's supported `inherit`, `flash` and `pro` tiers.

### Security

- Read-only roles use explicit tool allowlists.
- High-impact Git, publication and recursive deletion commands require explicit user approval.
- Candidate scope reconciliation and mandatory evidence gates remain fail-closed.

## [1.0.0] - 2026-08-22

Published as “General Availability” but not production-ready: the native Antigravity validator did
not discover its MCP server or hook and no self-contained binary artifact was attached. This tag is
historical and must not be moved.
