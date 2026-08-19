---
id: K-36
date: 2026-07-31
layer: kernel
title: "KV's disqualifier is missing data-residency, not a Regional-Services binding ban — and…"
status: accepted
aliases: []
tracking: []
---
# K-36 — KV's disqualifier is missing data-residency, not a Regional-Services binding ban — and…

**KV's disqualifier is missing data-residency, not a Regional-Services binding ban — and residency-pinned stores (D1 `eu`, DO jurisdictions) now reopen the cache K-30 foreclosed** (refines K-30/K-26; bears on open question 5). K-30 recorded "Workers KV is incompatible with Regional Services" and let open question 5 inherit it as "the router's per-request directory read cannot be cached". Verified against current Cloudflare docs, both halves need correcting. **The mechanism first**: Regional Services regionalizes execution and TLS termination and **does not extend to a worker's outgoing subrequests**, so a regionalized worker *can* bind and call KV — "cannot bind KV" was an over-reading of a "Not supported" cell in Cloudflare's data-localization compatibility matrix. What actually disqualifies KV is that it carries **no jurisdictional storage restriction** ("not supported today" per that same matrix): KV is centrally stored and globally cached with no `eu` pin, so caching a hostname's route in it places residency-bound directory data in a global store. The foreclosure of *KV specifically* stands; its stated reason was wrong. **The corollary is now false**: residency-pinnable stores KV lacks have since shipped — **D1 gained `eu`/`fedramp` jurisdictions (2025-11-05)**, and **DO jurisdictions cover `eu`/`us`** (`us` added 2026-06-26) — so a jurisdiction-pinned D1 read-replica of the hostname map, or per-jurisdiction cache DOs, is a **residency-safe** cache for the hot path. Open question 5's residency objection is answerable; what remains is the **freshness** half it always also carried — a cached route that keeps serving a suspended tenant blunts §7's "live weapon" — which is independent of residency and is the actual thing to settle

## Why

Worth a decision rather than an edit to K-30 because the ledger is append-only and K-30 conflated two facts, the stronger of which aged out. The correction is not academic: the router's uncached per-request singleton read (control-plane.md §4.7) is the sharpest residual scaling dependency, and K-30's reasoning implied it was **unfixable** under residency, so the whole hot path looked stuck behind a platform constraint. It was stuck behind a *2026-era* platform constraint — D1/DO jurisdiction pinning removes the residency blocker, and the suspension-freshness blocker is a design problem we own, not a Cloudflare limit, which is where open question 5's effort should now go. Two honest caveats, in the K-28/K-29 spirit of not trusting a doc where a deployment is cheap: D1 jurisdiction pinning is recent and its read-replica **consistency model must be checked against a per-request read** before building on it; and these are current Cloudflare capabilities — re-verify at build time, the same discipline that produced this correction to K-30
