---
'create-substrat': minor
---

The scaffold is pushable from day one. The template gains `src/worker.ts` (the
sandbox-clean Cloudflare shape: own `ScopeDO`, the full platform-gated
`/internal/*` management contract — provision, reconcile, tables, query,
platform-requests, snapshot/export/restore/bookmarks/rewind — and a clearly
marked auth seam; the dev `x-principal` header is the only caller resolution
until real auth is wired) and `src/provision.ts` (node-free MODULES/ROLES/
grant shapes + `definePermissions`, registered by both hosts and read by
`substrat push`). The generated package.json now carries
`substrat.permissions` + `substrat.runtimeNeeds` (the CLI derives the deploy
config — no wrangler.jsonc), a worker typecheck config, and current version
pins (kernel line ^0.39.0, engines ^0.3.37, plus @types/node that the old
scaffold only got by hoisting luck).
