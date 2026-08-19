---
id: K-23
date: 2026-07-19
layer: kernel
title: "Identity pools are registered, and declare topology rather than audience"
status: accepted
aliases: []
tracking: ["#48"]
---
# K-23 — Identity pools are registered, and declare topology rather than audience

**Identity pools are registered, and declare topology rather than audience** (§4.3; completes #48 after K-22's tenant-scoped key). A directory `identity_pools` row per provider declares `central` (serves many tenants — the same `externalId` across tenants is one human) or `tenant-bound` (serves exactly one, named on the row — the same `externalId` across tenants is two humans colliding). `linkIdentity` refuses an unregistered provider and refuses a tenant a tenant-bound pool does not serve; resolution needs no extra check because K-22's key already scopes it. A provider string names exactly one pool, so separate per-tenant deployments take distinct provider strings (`oidc:<issuer>`), which the identity contract's own comment already assumed. New `listIdentityTenants(provider, externalId)` answers "which tenants is this login in" and is **central-only** — it throws on a tenant-bound pool rather than returning the single obvious answer, because asking is a category error the caller should see

## Why

K-22 stopped the bleed but left the modes *unenforceable*: `provider` was a free string with nothing behind it, so any provider could claim any tenant and nothing recorded whether cross-tenant sameness meant "same person" or "id collision". Without that fact, cross-tenant identity cannot be offered safely at all — which is the actual blocker for a branded multi-club product, not the key. Splitting topology from audience is what RallyPoint forces: §4.3's table gives central pools to *staff*, but a padel player is a consumer on a branded platform where cross-club play is the product, so the audience labels are shorthand and the topology is the enforceable fact. Refusing unregistered providers rather than defaulting follows the kernel's deny-by-default posture — a defaulted topology would be a guess about whether two humans are one
