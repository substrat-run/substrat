---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Every list read pages the same way: the admin-log cursor convention, generalized.
`@substrat-run/contracts` gains `pagination.ts` (`listPageQuery` — limit default 20,
max 200 — `ListPage`, `Page<T>`, `pageOf`); every `HostAdmin.list*` takes an optional
keyset page (unset stays unbounded for in-process callers); both adapters implement
the keyset SQL and the contract suite proves it. **Wire change:** every control-plane
GET list route (`/tenants`, `/scopes`, `/verticals`, `/verticals/:slug/versions`,
`/channels`, `/channels/:channel/history`, `/hostnames`, `/roles`, `/admin-log`) now
returns `{ entries, nextCursor }` and defaults a 20-row page — older CLI versions
parse these as bare arrays and must upgrade; this CLI walks the cursor wherever it
needs the complete list.
