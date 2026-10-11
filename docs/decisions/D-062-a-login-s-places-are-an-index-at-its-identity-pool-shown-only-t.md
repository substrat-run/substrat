---
id: D-62
date: 2026-10-11
layer: plan
title: "A login's places are an index at its identity pool, shown only to that login on the issuer's own origin; verticals report into it and never read it"
status: accepted
aliases: []
amends: []
tracking: ["#1670", "#1694"]
---
# D-62 — A login's places are an index at its identity pool, shown only to that login on the issuer's own origin; verticals report into it and never read it

**The maintainer's answer on [#1670](https://github.com/substrat-run/substrat/issues/1670), recorded.** A login has no view of where it holds a principal across tenants, and no vertical may be given one: that would put one tenant's membership data inside another tenant's app, against D-40. The view is an account surface on the platform's own origin, outside every vertical. It lists the places a login holds a principal and deep-links into each.

**Where the index lives.** With the identity pool, beside the issuer whose `sub` it is keyed on. A `sub` is comparable only across tenants that share an issuer ([K-23](./K-023-identity-pools-are-registered-and-declare-topology-rather-th.md)), so the index is scoped to one pool by construction. It is keyed on what the issuer mints ([K-25](./K-025-the-idp-is-not-fronted-whatever-mints-externalid-becomes-the.md)) and invents no platform-level user. Residency ([K-7](./K-007-jurisdiction-on-the-scope-row-chosen-at-provisioning-immutab.md)) follows the pool.

**What it may show.**
- A login sees only its own memberships. The surface is never enumerable: it does not reveal which tenants exist beyond the caller's own, and a probe for another `sub` learns nothing.
- An entry is `(tenant, scope, surface/hostname, display name)`, enough to deep-link and nothing more about the tenant.
- Removing a membership removes the entry. The index does not drift from the per-tenant directories that own the truth.

**Who may put an entry there.** Places are vouched for by the platform alone: the dashboard registers each app with its client, hostname and name. A vertical reports one thing, that a `sub` is or is no longer bound in its own scope, authenticated as the client the platform registered for it, and the issuer keeps an addition only for a login it has itself issued to that client. Self-registration by a vertical was declined: it would let any open-DCR client put a name of its choosing on the one page users trust.

## Why

A vertical sees one tenant. Any cross-tenant list handed to one hands a tenant data about people's other memberships, and the issuer is the one party that already knows a `sub` across tenants. Putting the index there adds no new party to the trust.

**Deferred, not rejected.** A pushed per-login projection into verticals, for an in-app place switcher or "shared with me". It would put cross-tenant data inside verticals and needs its own decision.

Shipped in [#1694](https://github.com/substrat-run/substrat/pull/1694); the open parts of the rollout are listed on the issue.
