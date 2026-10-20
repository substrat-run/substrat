---
id: D-39
date: 2026-07-28
layer: plan
title: "The permission registry ships in the deploy manifest; the declared surface is a per-version…"
status: accepted
aliases: []
tracking: []
---
# D-39 — The permission registry ships in the deploy manifest; the declared surface is a per-version…

**The permission registry ships in the deploy manifest; the declared surface is a per-version artifact, never a live table** (completes the §4.5 permission-diff split in control-plane.md; kernel siblings K-34/K-35). The registry — permission keys + descriptions, role templates, entity-grant shapes: exactly what `tools/permission-diff.mts` renders into `PERMISSIONS.md` — exists only at build time today; the deploy manifest carries `ownerGrants` and a `digests.permission` *hash* of it, so the platform commits to content it does not hold, which is why the dashboard grew a hardcoded third copy (`apps/dashboard/src/catalog.ts`). The manifest now carries the registry itself beside its digest: immutable per version, stamped at push, drift-proof by construction, and admission gains a mechanical version-to-version permission diff (orchestration.md's "permissions changed" badge gets its content). Rejected: a mutable "current permissions" table in the control plane (a second source of truth for a code-declared fact — drifts by design) and a self-describe endpoint on running verticals (turns a build-time fact into a runtime question and couples console/dashboard to reaching into scopes). The resulting layering, stated once: **declared** surface → version manifest (immutable); **operator** state (roles) → directory `_substrat_roles` via `listRoles` (runtime-mutable, correctly a table); **minted** grants → scope-local tuples, enumerable only via the audited admin-query RPC, never mirrored into the directory. Trust caveat inherited from self-serve-deploy.md §3: on an opaque-bundle push the shipped registry is pusher-claimed exactly as the digest is — verified only under the controlled build (model A)

## Why

The pattern existed twice already: permission keys are never renamed and evolve additively, which is what makes an immutable per-version artifact the natural home; and `digests.permission` already committed to this exact content — shipping content beside its hash is completion, not addition. The tell that the data had no home: three partial copies (`PERMISSIONS.md` in the repo, a hash in the registry, a hardcoded catalog in the dashboard), none consumable by the surfaces (§4.5's console, a dashboard permissions tab) that need it. Both rejections are one argument in two directions: state that can drift from enforcement is worse than no state
