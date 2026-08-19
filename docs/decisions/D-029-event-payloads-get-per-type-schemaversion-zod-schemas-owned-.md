---
id: D-29
date: 2026-07-14
layer: plan
title: "Event payloads get per-(type, schemaVersion) Zod schemas owned by the emitting engine"
status: accepted
aliases: []
tracking: []
---
# D-29 — Event payloads get per-(type, schemaVersion) Zod schemas owned by the emitting engine

Event payloads get per-(type, `schemaVersion`) Zod schemas owned by the emitting engine; emit validates against them (today `payload: z.unknown()` — the manifest declares versions nothing pins); JSON Schema emitted, checked in, CI-diffed with breaking-change linting — the same pipeline as 22's API surface. Consumers keep their own lenient parse (producer-strict / consumer-lenient makes additive change safe by construction). AsyncAPI stays deferred; when polyglot/external consumers exist it is **generated** from these schemas (AsyncAPI 3 embeds JSON Schema), never hand-authored

## Why

Events are the loosest coupling and the only surface where a break ships silently; a hand-written AsyncAPI doc would be a second source of truth drifting from the running validators. Amends 22 (§5.6)
