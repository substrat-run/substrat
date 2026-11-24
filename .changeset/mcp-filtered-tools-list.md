---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/vertical-host": minor
---

kernel: `ScopeStub.heldPermissions()` reads the keys a person could pass a check for in a scope (held at the scope or on one record), capped by the stub's delegation; `heldKeysOf` builds it from a checker's holdings.
adapter-sqlite: a person's stub answers `heldPermissions()`.
adapter-cloudflare: a person's stub answers `heldPermissions()`, read inside the scope's Durable Object.
contract-tests: the delegation-ceiling suite holds `heldPermissions()` to the same ceiling as a check.
vertical-host: the MCP endpoint's `tools/list` shows only the tools the caller could call; a call to an unlisted tool is still answered by its own check.
