---
id: D-44
date: 2026-08-06
layer: plan
title: "Native static assets are an additive allow to the hosted-vertical sandbox — the bytes are…"
status: accepted
aliases: []
tracking: ["#340", "#286"]
---
# D-44 — Native static assets are an additive allow to the hosted-vertical sandbox — the bytes are…

**Native static assets are an additive allow to the hosted-vertical sandbox — the bytes are trusted, the content-address is verified** ([#340](https://github.com/substrat-run/substrat/issues/340); self-serve-deploy.md §4.1). Every dispatched vertical inlined its built SPA into the worker bundle as base64 (`gen-assets.mjs` → `assets.generated.ts`), justified by "WfP dispatch has no static-assets path" — stale since Workers for Platforms grew `assets-upload-session`. That workaround cost ~+33 % in bundle size against the script-size limit (Manyfold's inlined SPA alone is 3.9 MB of source), re-parsed the whole UI on every cold start, and invoked the worker for every image. A vertical now declares `runtimeNeeds.assets` — a directory plus path-routing config (`notFoundHandling`, `runWorkerFirst`) — and the platform uploads the files to the runtime's own asset store through Cloudflare's three-step upload session: served from the edge without invoking the worker, and versioned atomically with the code. **D-40's binding allowlist cannot rule on this either way** — native assets are a top-level upload path, not a binding — so the decision is written down separately: assets are admitted because they carry no reach (inert public bytes: no code, no credential, no cross-tenant name), while their **hash is re-derived from the received bytes and refused on mismatch**, because the asset store is content-addressed and deduped namespace-wide, so bytes stored under an address they do not have could decide what a *different* vertical's identical-hash asset serves. An `assets.binding` (programmatic `env.ASSETS`) stays refused, at push time rather than silently

## Why

The reflex was to read this as "one more binding type" and extend D-40's allowlist; it is not a binding at all, which is why the sandbox question had to be re-asked from scratch instead of answered by precedent. Re-asking it found the one genuinely non-inert property — the dedup key is SHARED, so it is the only part of an asset upload a tenant must not choose freely — and that single verification is what lets everything else stay trusted. Retaining the file MANIFEST rather than the bytes is what makes a promote work: the archive script gives back the modules (#286), content-addressed dedup gives back the assets, and a re-serve that finds bytes the runtime has dropped refuses instead of quietly serving a half-broken page
