---
'@substrat-run/cli': minor
---

Add `substrat scope domain <scopeId> --domain <fqdn>` — bind a custom domain to ANY owned scope,
not just a prod app (#509). The hostname bind path was already scope-generic; this is the
scope-addressed surface a bare **preview** or long-lived **test** scope needs, so a pinned preview
can carry a stable address like `crm-test.ahero.se` (the router resolves `hostname → scope` and
serves whatever version the scope is bound to). `--surface` (default `app`) and `--canonical`
(default: an additive alias, never demoting the `--<tag>` URL) round it out; it walks the same
DNS/cert issuance as a prod domain.

The dashboard gains the matching builder surfaces (a per-vertical **Previews & environments** panel
— create/pin/delete a preview and attach a custom domain to one — and a per-scope **Bind version**
action), and the docs get a new **Environments & previews** guide plus a sweep of the pages that
still described the retired `dev`/`staging` channels.
