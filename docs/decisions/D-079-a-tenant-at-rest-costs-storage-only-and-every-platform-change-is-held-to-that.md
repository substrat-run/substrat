---
id: D-79
date: 2026-11-25
layer: plan
title: "A tenant at rest costs the platform storage only, and every platform change is held to that"
status: proposed
aliases: []
amends: []
tracking: ["#3316"]
---

# D-79 — A tenant at rest costs the platform storage only, and every platform change is held to that

> **Proposed 2026-11-25, not ratified.** The numbers are in [rfc/tenant-scale.md](../rfc/tenant-scale.md)
> (§5.6). Nothing in it is built.

**A tenant nobody uses costs the platform its stored bytes and nothing else.** No scheduled job wakes
its objects, writes rows for it, or calls Cloudflare on its behalf
([K-69](./K-069-nothing-iterates-over-every-tenant-on-a-schedule-work-starts-from-an-event-or-the-owning-object-s-alarm.md)).
A platform change that adds a per-tenant cost at rest says so in its pull request, with the cost at
100,000 tenants, and needs the owner's approval.

**The target is about $0.00005 a month per idle tenant** at list price: a directory object of about
25 KB, a home scope at rest of about 200 KB, two edge keys, a registry row, an index row and a few
issuer rows. Three things a tenant may have cost more, and each is a plan decision rather than a
storage cost:

- **A custom domain**: $0.10 a month for each above the first 100 on the account, and at most 50,000
  custom hostnames below an Enterprise plan.
- **A per-tenant D1 database or R2 bucket** a vertical declares: 100,000 of each included on the
  account, then $0.10 a month each.
- **Logs and traces at rest**: none for an idle tenant.

**A free tier is priced from this.** A free tenant at rest is a storage cost; a free tenant's use is
priced from its requests, rows and logs, which are metered already (#3316).

## Why

**Today an idle tenant costs about $0.38 a month**, about 7,600 times the target, nearly all of it rows
written in the directory: the pass's bookkeeping and access-log rows and the daily whole copy, plus 96
wakes of each scope a day. At 100,000 tenants that is about $38,000 a month for tenants that do
nothing, if the single object survived it. The cost of an idle tenant is the number a free tier
multiplies by the largest factor, so it is the one worth holding as a rule.

## Open choices for the owner

- Whether a free tier includes a custom domain.
- Whether to move to Enterprise for Cloudflare for SaaS before 50,000 custom hostnames, or price a
  custom domain so that tenants who want one pay for the plan.
- The budget for an idle tenant's cost that a change may add without approval (zero proposed).

## Not built

The rule. The measurement exists: the daily cost rollup (#3329) attributes Cloudflare's billed usage
per scope.
