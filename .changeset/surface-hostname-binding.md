---
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

Surface hostname binding is operator-facing (K-26 multi-surface exposure — the Egeryds
EKA ask). The vertical side always worked: one scope, one worker, one bundle, and
`readRoutedNode(...).surface` decides which app the hostname serves. What was missing
was any way to GIVE a second surface a URL; `bindHostname` existed but nothing
operator-facing called it.

The dashboard's Domains tab is now real: it lists an app's bindings (hostname, surface,
status, canonical), mints a platform hostname for a surface (`crm.global…` + `eka` →
`crm-eka.global…`, live immediately — it rides the wildcard cert), records a custom
domain as `pending` into the §4.2 lifecycle, and unbinds with the canonical-demotion
rule stated in the UI. The default hostname is refused for removal — deleting the app
retires it. Both mutations gate on `dashboard:provision-app` in the caller's own scope
and land on the activity trail as `hostname-bound` / `hostname-unbound` (migration 0009
widens the event CHECK, rebuild-and-copy like 0005–0008). A custom-domain form never
accepts platform names — that path is the mint, so labels can't be squatted cross-tenant.

The control plane's hostname routes join `BUILDER_ROUTES`, tenant-narrowed: a builder
lists only its own tenant's rows (a foreign `tenantId` in the query loses silently),
binds only into its own tenant, never supplies `region` (an EU-residency claim, K-30),
and a foreign hostname on status/unbind reads 404 — indistinguishable from absent. CLI
parity rides that: `substrat hostnames <slug>` lists an install's bindings,
`… bind <slug> --surface eka [--domain …] [--scope …]` mints or records, `… unbind
<hostname>` removes.

Verticals may declare their surfaces — package.json `substrat.surfaces: [{ name,
label }]` rides the deploy manifest to the registry like `envSpec` (metadata, not
behavior, not in any digest; the anchor #111's per-surface operation-sets extend
later). The declaration buys the Domains tab a picker instead of free text, and a
push-time warning naming any hostname still bound to a surface the new version stopped
declaring — the same spirit as the permission-surface gate, advisory tier. Free-text
surfaces stay valid everywhere; declaring nothing opts out of the check.
