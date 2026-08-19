---
id: D-22
date: 2026-07-12
layer: plan
title: "Contracts are Zod-first (zod-openapi on Hono)"
status: accepted
aliases: []
tracking: []
---
# D-22 — Contracts are Zod-first (zod-openapi on Hono)

Contracts are Zod-first (zod-openapi on Hono): Zod schemas in a semver'd package are both source of truth and runtime validators; OAS/JSON Schema emitted, checked in, CI-diffed with breaking-change linting; AsyncAPI deferred; TypeSpec/Arazzo dropped until polyglot consumers exist; connectors generate validators from vendor OAS

## Why

One source of truth at the enforcement boundary — the reviewed artifact is the running validator; TS end-to-end (21) removes TypeSpec's polyglot payoff; auth-platform Hono muscle. Amends 15 (§5.6)
