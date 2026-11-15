---
'@substrat-run/vertical-host': minor
---

`mcpScopeOptions(c, subject)` hands a delegated MCP call's delegation to the endpoint's per-tool check and returns the `getScope` options that carry it to the kernel, so every permission check the operation makes is held to the delegated scope, not only the tool's leading key.
