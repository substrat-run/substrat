---
id: D-38
date: 2026-07-26
layer: plan
title: "Builders keep the substrate vocabulary; the Cloudflare mapping lives behind the platform"
status: accepted
aliases: []
tracking: ["#190"]
---
# D-38 — Builders keep the substrate vocabulary; the Cloudflare mapping lives behind the platform

**Builders keep the substrate vocabulary; the Cloudflare mapping lives behind the platform** (#190). A vertical declares what it needs from the runtime in Substrat terms — `substrat.runtimeNeeds` in its package.json: an entry module, `needsNodeCompat`, an optional pre-bundle `build` command, and its own `stores` (binding → durable state class). At push time the CLI derives the substrate-native config (a generated wrangler config fed to the bundler via `--config`, removed after the build) and assembles the deploy manifest from the same object, so declaration and bundle cannot drift. The platform pins the compatibility baseline (`RUNTIME_BASELINE` in contracts) — a builder states needs, never substrate config, and advancing the baseline is a platform release concern. Datastores beyond own stores are deliberately absent from the vocabulary: those are platform-provisioned (self-serve-deploy.md §4's open question resolves toward the platform minting the store and injecting the id), never bundle-declared. A hand-authored `wrangler.jsonc` remains the expert/legacy path and is ignored when `runtimeNeeds` is present

## Why

The vocabulary is small *because* §4 is strict: the sandbox contract already refuses everything except a vertical's own stores, so own-stores + node-compat + a build command is not a subset of what a builder may say — it is the whole of it, which is what makes the mapping mechanical rather than a leaky abstraction. The honest limit, stated so it is not mistaken for solved: this neutralizes the *declaration*, not the *toolchain* — wrangler remains the client-side bundler in every builder's CI (`npx wrangler deploy --dry-run`), and swapping that is a different, bigger decision nobody has needed yet. The risk the gate existed for — baking CF assumptions into a "neutral" vocabulary designed inside a one-substrate world — is bounded by the same smallness: four fields, each with an obvious meaning on any substrate that can run a worker-shaped bundle with durable state
