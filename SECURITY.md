# Security Policy

## Supported versions

Only the latest published 1.1.x release is supported. Version 1.0.0 is not supported.

## Trust boundaries

- Antigravity owns authentication, model access, sandboxing and permission prompts.
- Cycle stores no provider credential and does not proxy model traffic.
- Role capabilities are Antigravity custom-agent tool allowlists; the executor is the only writing role.
- The local control plane freezes candidate bytes, records direct evidence and refuses unproved delivery.
- Security proof execution is disabled unless the user explicitly enables it.
- Durable state and signing keys live outside the plugin installation directory.

The safety hook does not silently override the user. It returns `force_ask` for high-impact commands;
the user remains the final authority. Scope reconciliation and delivery gates do not rely on the hook.

## Reporting

Report vulnerabilities privately to the repository owner. Do not include credentials, private
source, exploit data from third parties or live customer data. Include the exact version, platform,
reproduction and the smallest non-sensitive proof.

## Release requirements

A supported release requires dependency audit, SBOM, artifact checksum, exact-SHA CI, Windows and
Linux clean-install evidence, and Windows signature verification. Missing evidence blocks release.
