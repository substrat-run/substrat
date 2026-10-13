---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': patch
'@substrat-run/router': patch
'@substrat-run/dashboard': patch
---

Peer calls now find an app installed under its tenant-pinned name. A push pinned to a tenant registers the vertical as `<tenantSlug>/<slug>`, while `substrat.calls` and `peers` usually name the bare `<slug>`. The resolver used to report such a target as "not installed in this tenant", the app's peer panel showed an empty target picker, and an explicit binding was refused.

A bare name now also matches the pinned spelling, but only in the calling app's own tenant, using the directory's slug for that tenant. It never matches another tenant's `<other>/<slug>` (a listed vertical someone else owns), and never the reverse: a declared `acme/crm` does not match a bare `crm`. An exact install wins over the pinned one, so a tenant running both still resolves. Two pinned installs stay ambiguous until one is bound. The rule is `peerVerticalSpellings` / `samePeerVertical` in the kernel. It applies to the router's call, a queued call in the drain (`resolvePeerInstance` on both adapters), explicit bindings and the dashboard's peer panel. A caller whose bare slug resolves to its own scope is refused as a self-call, on both legs. `resolveVerticalInstanceFrom` and `resolvePeerInstanceFrom` now take the tenant as `{ id, slug }`. Pass `slug: null` to match names exactly.

At the target's door, `verticalCaller` gains an optional `tenantSlug`. Only the platform sets it, from the directory. `peerCallerAt` maps a pinned caller onto the bare `peers` entry it matches. A declaration naming the caller's full registered spelling still wins. A door built before this ignores the field and matches exactly, as before. A peer-called target is now dispatched under its registered name, the same name its public dispatch uses.

Cross-vertical event edges keep exact matching, and so does `HostAdmin.resolveVerticalInstance`, their read.
