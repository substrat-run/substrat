---
id: K-15
date: 2026-07-13
layer: kernel
title: "UI composition (§7.4)"
status: accepted
aliases: []
tracking: []
---
# K-15 — UI composition (§7.4)

UI composition (§7.4): build-time composition of manifest-declared `ui` contributions into one React app per vertical; entity-view registry for cross-engine rendering; headless-first engine UI with copy-and-own screens; `@substrat-run/shell` seeded from shadcn-admin; three surfaces (office/field/portal); runtime microfrontends rejected; web-component slot kept as future escape hatch

## Why

Federation solves team-scale deployment we don't have and costs theming/versioning/agent ergonomics; the manifest, proof-path checker, and EntityRef registry are exactly the primitives a pluggable UI needs
