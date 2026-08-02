---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

Identity links ride the scope-local projection (#406): the control plane stays the
audited source of truth (`linkIdentity`/`unlinkIdentity`), and every identity write now
fans out into the tenant's projected scopes (`_substrat_identity_links`), with CP-less
delivery on the provision/reconcile channel entitlements already use. New surfaces:
`HostAdmin.listIdentityLinks` (the audited per-tenant gather), the
`projectedIdentityLink` contract shape, `identityLinks` on provision/reconcile payloads,
and `CloudflareScopeHost.resolveIdentityLocal` — the CP-less auth adapter's
`(provider, externalId) → principal` read against the scope's own storage, replacing
login maps compiled into the bundle (offboarding by deploy; revocation undone by version
rollback).
