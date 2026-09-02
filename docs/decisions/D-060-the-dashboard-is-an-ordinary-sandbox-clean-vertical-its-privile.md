---
id: D-60
date: 2026-09-02
layer: plan
title: "The Dashboard is an ordinary sandbox-clean vertical: its privileged half is a platform intent, not a narrowed credential"
status: proposed
aliases: []
amends: []
tracking: ["#1185", "#978", "#977"]
---
# D-60 — The Dashboard is an ordinary sandbox-clean vertical: its privileged half is a platform intent, not a narrowed credential

> Proposed, not accepted. It answers the open question [dashboard.md](../architecture/dashboard.md)
> §4 and §6 park, and it should be argued before [#1185](https://github.com/substrat-run/substrat/issues/1185)
> converts a single route.

**The Dashboard becomes an ordinary sandbox-clean vertical, and the privileged exception is deleted
rather than relocated.** [dashboard.md](../architecture/dashboard.md) §4 left the seam an open
question with two candidates — *"a dedicated host capability the Dashboard deployment is granted, or
a 'control-plane connector' reusing the connector seam's egress + authority machinery"* — and both
assume the Dashboard keeps a platform authority that it narrows itself. **Neither is taken.** Its
privileged **mutations** ride `ctx.requestPlatform`
([platform-intents.md](../architecture/platform-intents.md), built and in production since
[#444](https://github.com/substrat-run/substrat/issues/444)), which is already the general primitive
for this exact shape: a sandbox-clean vertical causing a privileged, platform-owned mutation *on
behalf of a user it authorized with its own roles*. The decisive property is that **identity is
inherent, never asserted** — an intent lives physically in one tenant's scope DO, so the
drain-executor reads `(tenant, scope)` instead of being told it. There is no credential to mint,
narrow, rotate or forge, and no tenant argument to refuse. That is strictly stronger than what
either candidate can reach, because both end at *"mint something that claims a tenant, then verify
the claim"* — which is what the deployed system does today and what §4 has already retracted:
`TenantNarrowedControlPlane` ([authority.ts](../../apps/dashboard/src/authority.ts)) pins `tenantId`
in its constructor, but the credential behind it is the fleet-wide `SERVICE_TOKEN`, which
`packages/control-plane-api/src/api.ts` resolves to a `kind: 'staff'` principal with reach over
every tenant, and every write is stamped `SERVICE_ACTOR`. The narrowing therefore holds only as far
as `apps/dashboard/src/worker.ts`, the same process that holds the token, so a Dashboard bug is a
cross-tenant bug rather than a 403. Under intents a Dashboard bug's blast radius is what
platform-intents.md already bounds: *"extra scopes for tenants that already run it, bounded by
quota"*. The fit is not analogical — `provision-sibling`, intent #1, **is** the create-an-app flow,
and the dashboard scope sits inside the customer's own tenant beside the scopes it provisions, so
the Dashboard's entire privileged surface ("act on my own tenant") is exactly the boundary an intent
enforces as a physical fact. **Reads split by who owns the fact, and that half is the larger piece
of work**: of the ~50 distinct control-plane methods `apps/dashboard` calls, the highest-frequency
are all reads (`listCatalog`, `listChannels`, `listPreviews`, `listVerticals`, `listVersions`), and
intents are explicitly *"not general synchronous RPC"*. So — a fact the **tenant** owns (their apps,
deploys, hostnames, members, plan) is **projected into their own scope** and read with `ctx.sql`,
the pattern [D-42](./D-042-the-platform-delivers-a-tenant-s-entitlements-with-provision.md) already
uses to deliver entitlements and role definitions, and the read model
[master-plan](../master-plan.md) already rules non-optional — a per-scope dashboard must never hit
Tier 2 directly, so scope-level dashboards need one. A fact the **platform** owns (the cross-tenant
catalog, provider-proxied observability, the admin log)
stays behind a **read-only, tenant-scoped seam** in the Dashboard's shell — [#977](https://github.com/substrat-run/substrat/issues/977)'s
credential class, but read-only and far smaller than today's read-and-write fleet token. Record
keeping stays synchronous `ctx.sql` in the vertical, so [D-31](./D-031-the-admin-s-record-keeping-half-becomes-a-vertical-and-is-th.md)'s
effecting/record-keeping line does not move and K-8 is untouched — the effecting half simply *is*
the drain-executor. **Three residues, named rather than discovered later.** Sign-up bootstrap cannot
be an intent (there is no tenant yet, so nothing owns the DO identity would be inherent to) and
stays a controlled platform action outside the vertical, as §4 already says — one action, not a
standing capability. Lifecycle mutations become `202` + poll, which provisioning, hostname binding
and promote already are, but the incident path (suspend) should stay synchronous host code, as
[membership.md](../architecture/membership.md) §9 warns. And the Dashboard becomes the busiest
intent producer in the fleet, so `requestPlatform`'s pending-request ceiling and the per-scope drain
batch need sizing before it lands rather than after

## Why

The two candidates §4 offered are the same design at different distances from the process that
holds the token, and the retraction that closed #977's documentation half is the evidence: option
(a) *is* `TenantNarrowedControlPlane`, already built, already honest about being client-side, so
formalizing it would be building the thing the docs had just finished admitting does not hold.
Option (b) is better — the connector seam has server-side grants and audited egress — but it still
mints a credential that *represents* a tenant, which means a verification step, a rotation story and
a forgery surface, all of which intents delete instead of designing. This is
[D-30](./D-030-control-plane-the-shared-layer-across-n-per-vertical-deploym.md)'s own rule applied
to ourselves: never convert a structural guarantee into a configured one. It also dissolves the
dilemma #1185 states as an unavoidable cost — that afterwards the exception either lives *inside*
the vertical model, weakening the invariant the sandbox contract rests on, or moves wholly to the
host half, making the split larger. Both branches assume the vertical needs privilege; it does not,
so the third door is that the exception stops existing. Nor is this a new pattern:
[K-22](./K-022-the-membership-seam-is-a-connector-and-orgid-becomes-a-brand.md) already rejected an
in-scope cross-DO write and chose emit-then-executor on D-18's triage rule, and platform intents are
that same pattern promoted to a kernel primitive — so choosing it for the Dashboard is recognition
rather than novelty, and makes the Dashboard consumer three behind Manyfold site creation and the
`connector:<provider>` deliveries of [#618](https://github.com/substrat-run/substrat/issues/618),
which is D-27's extraction condition met rather than an exception to it. The bootstrap objection
runs the other way from how #1185 states it: an ordinary vertical is recovered by the platform's
out-of-band host code — `apps/console`, which exists — so the requirement this creates is "keep the
console capable", which is healthier than "keep the Dashboard privileged", and the residual
chicken-and-egg is the small one [membership.md](../architecture/membership.md) §9 already called
trivial (an out-of-band seed for the platform tenant's own scope). **The honest costs.** This does
not fix reads, and the scope-local read model is genuinely new machinery — a continuous
platform→scope projection where D-42 only ever delivered facts at provision time — so the entry
decides a direction and not a schedule; whoever picks it up should expect the read model, not the
intents, to be the bulk of the work. Interactivity gets worse before it gets better on every
mutation that is not already async, and a design that answered that with a spinner would be papering
over latency the router kick is supposed to remove. And the whole argument is downstream of
[#1184](https://github.com/substrat-run/substrat/issues/1184): until membership is an in-scope
capability with K-21's assignment bound, the Dashboard-as-vertical cannot self-serve the one surface
D-31 built the case on, whatever seam its privileged half uses
