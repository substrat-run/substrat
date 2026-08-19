---
id: D-47
date: 2026-07-30
layer: plan
title: "Permission registry is a required, TypeScript-derived manifest field"
status: accepted
aliases: []
tracking: []
source: docs/architecture/permission-registry-enforcement.md §7
---

# D-47 — Permission registry is a required, TypeScript-derived manifest field

> **Ratified 2026-08-19.** Transcribed from docs/architecture/permission-registry-enforcement.md §7 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**Permission registry is a required, TypeScript-derived manifest field** — completes D-39 and retires its checked-in machine artifact. The surface is declared once via a typed `definePermissions()` (compile-checked), discovered from a declared entry rather than a by-name `seed.ts` re-export, and the wire registry is *derived at push* from the built entry — no `permissions.json` in git. `deployManifest.registry` becomes required; a missing surface is a hard error at both the CLI and the trust boundary; honest-empty stays expressible only explicitly. `PERMISSIONS.md` remains the checked-in human review artifact. Rejected: hand-authored JSON, `seed.ts` discovery, a self-describe endpoint, a mutable CP table. **As built, two refinements:** push tolerates a node-ful entry (bundling with packages external, resolved from the vertical's own `node_modules`), and contracts exports a lenient `storedDeployManifest` so manifests persisted before `registry` existed still re-parse. The checked-in `permissions.json` fallback was **not** needed — `buildPermissionRegistry` reproduced all seven committed files byte-for-byte, so they were deleted.

## Why

D-39 made the content drift-proof but left the mechanism opt-out-able by convention and introduced a machine-only generated file in git — both are the derived-state-that-drifts this design refuses everywhere else. **Note on numbering:** this entry originally proposed itself as decision 41, a number already held by the scope-local entitlements projection (#304). The collision went unnoticed because neither document could see the other — which is the argument for the generated log this entry was split into.
