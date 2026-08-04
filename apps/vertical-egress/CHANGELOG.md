# @substrat-run/vertical-egress

## 0.0.1

### Patch Changes

- 714ccf4: Cross-vertical HTTP now works: a dispatched vertical calling another vertical's public
  `*.substrat.run` API used to 522 at the same-zone edge, because a same-zone worker
  subrequest never re-enters the router (#442). The concrete casualty was OIDC — the
  AuthHero console fetching its issuer's JWKS from another vertical on our own zone timed
  out, so every valid login 401'd.

  Adds `@substrat-run/vertical-egress`, a Workers-for-Platforms **outbound worker** bound
  to the `substrat-verticals` dispatch namespace. Every dispatched vertical's `fetch()` is
  routed through it: platform-bound egress (any host that is or ends in `PLATFORM_BASE_DOMAINS`)
  is handed back to the router over a service binding — a direct in-process call that dodges
  the same-zone loopback and re-enters normal resolution+dispatch — and everything else passes
  straight through to the public internet, untouched. This keeps K-27 intact (a vertical still
  reaches the platform only through the router) and needs no vertical code change.

  Scoped to the router's dispatch binding (the login path). The control plane's dispatch
  binding is deliberately left alone — its dispatched calls are internal provisioning, not
  cross-vertical public HTTP, and wiring it would create a deploy-order cycle (it deploys
  first). The caller-identity half — who may call whom — is #303's outbound network policy,
  which layers on this worker later via the binding's outbound `parameters`.
