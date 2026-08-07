---
"@substrat-run/control-plane-api": minor
---

feat(console): links into Cloudflare — find the right DO, database and bucket

The console rendered every identifier an operator needs and never said where any of them
resolves, so "which Durable Object is this scope?" ended in the dashboard's search box. Two
reads close that:

- `GET /platform/runtime` — the account and dispatch namespace the refs resolve in, injected
  by the host (`platformRuntime`) exactly like the observability reader. It carries **no
  credential**: it is the account the deployment already advertises in every dispatch URL.
  Unconfigured answers `null`, not 501 — a self-host control plane is a normal deployment,
  and the console degrades to plain identifiers rather than an error.
- `GET /tenants/:t/stores` — the #301 and #473 ledgers as inventory. `listTenantStores` was
  documented as the console's read from the start and no route exposed it; on Cloudflare the
  `ref` IS the D1 database id and the R2 bucket name, so it is directly addressable.
- `GET /platform/do-namespaces?script=…` — a scope's Durable Object namespace, by the id the
  dashboard addresses it with. Nothing in the platform record carries that id, so it is
  resolved through a host-injected reader (`createCfDoNamespaceReader`, TTL-cached, bounded
  page walk) and narrowed to the asked-for script server-side — an account-wide listing has
  no business crossing to a browser. 501 when unconfigured, because "I cannot look" and "that
  script defines none" are different answers.

All staff-only (absent from `BUILDER_ROUTES`, so a builder 403s), read-only, and additive.

Console side: tenant detail gains a **Stores** card and scope detail a **Cloudflare** card
(serving script, Durable Object, the tenant stores for that scope's vertical). Link
construction is one module with one rule — a link is built only from coordinates we actually
hold, and anything missing renders as the plain id rather than a URL that lands somewhere
arbitrary. The URL shapes are pinned in one table, verified against the dashboard, and
covered by a test, so a Cloudflare reshuffle is a one-line fix.

A Durable Object shows its NAME (the scope id verbatim — `SCOPE.idFromName(scopeId)`, the
only handle a human can carry, since the hex object id is a hash) and links to the *namespace*
it lives in, falling back to the namespace list when the lookup is unavailable. There is still
no per-object page in the dashboard; this is as close as the provider allows.
