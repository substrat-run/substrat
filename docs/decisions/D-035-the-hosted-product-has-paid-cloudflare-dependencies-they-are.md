---
id: D-35
date: 2026-07-20
layer: plan
title: "The hosted product has paid Cloudflare dependencies; they are a cost line, not a discovery"
status: accepted
aliases: []
tracking: []
---
# D-35 — The hosted product has paid Cloudflare dependencies; they are a cost line, not a discovery

**The hosted product has paid Cloudflare dependencies; they are a cost line, not a discovery** (K-26, K-28, K-30; cashes in D-32). Three separate findings each concluded "this belongs in D-32's cost model" and none of them landed there, which is how a plan dependency becomes a procurement surprise. Stated together: **Advanced Certificate Manager** (~$10/month) — required, because default hostnames are `<slug>.<jurisdiction>.substrat.run` and a two-level hostname is beyond Universal SSL's root-plus-first-level coverage. **Regional Services** — an Enterprise add-on, and what pins TLS termination; without it the EU claim has no mechanism. **Workers for Platforms** — a paid add-on, verified to fit (K-28) and **not enabled on our accounts** (`code: 10121`); it gates customer-pushed verticals, not the current milestone, because platform-owned deploys already work through the ordinary Workers upload API. **Cloudflare for SaaS** — 100 custom hostnames free on every plan, then $0.10 per hostname per month up to 50,000, which is what customer-owned domains cost. **Two domains** — a brand domain and a separate, PSL-listed domain for tenant apps, because a tenant subdomain that can set a cookie on the parent reaches the portal and every other tenant

## Why

The pattern worth naming is that each of these was found by checking rather than recalling, and three of them contradicted what seemed obvious: WfP looked like a technical risk and is a purchase decision; D1 looked like hints-only and offers real jurisdictions; KV looked like the natural cache and is incompatible with the residency claim. The costs are small individually and the point is not their size — it is that a hosted compliance product whose residency guarantee rests on an Enterprise add-on has a business dependency that must be visible when pricing is set, not when a customer asks for a DPA. Note also what is NOT a cost: nothing here gates the current milestone. Wildcard proxied DNS is free on all plans, Universal SSL covers first-level subdomains, and instances of a deployed vertical need no per-customer deploy at all
