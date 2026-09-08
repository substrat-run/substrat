---
"@substrat-run/adapter-cloudflare": minor
---

`CloudflareScopeHost.revokeScopeRole(scopeId, principal, roleKey)` — the counterpart `assignScopeRole` went without. A tombstone on the scope's role tuple, as `unassignRole` writes: the principal loses the role's permissions on the next check, a repeat revoke is a silent `false`, and a later `assignScopeRole` grants again (#1161).
