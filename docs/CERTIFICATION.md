# Certification contract

A release is production-ready only when the receipts bind one clean exact SHA and one artifact
digest to all required lanes:

- strict type-check, build and behavioral suite;
- Antigravity native validation reporting 24 skills, seven agents, one MCP server and one hook;
- package allowlist, SBOM, checksum and provenance;
- repeat-critical 20/20 using real MCP workflow transitions;
- controlled 500k-file benchmark with recorded limits;
- Windows x64 and native Linux x64 clean install, doctor, quick/full, repair, restart, upgrade,
  uninstall and rollback;
- Windows Authenticode signature verification;
- second-directory installation from the released artifact and checksum re-verification.

WSL is supplementary and never substitutes for native Linux. macOS is compatible but untested until
a separate lane is completed. A missing lane is `BLOCKED`, not a pass inferred from another host.

The 500k lane uses an isolated Ubuntu runner, requires at least 6 GiB free memory and 15 GiB free
disk before generating any fixture, and is hard-capped at 120 minutes. Its fixture contains 50,000
semantic JavaScript files and 450,000 tracked fallback files, followed by cold and warm index passes.
