---
id: D-28
date: 2026-07-14
layer: plan
title: "Engine compatibility surface pinned"
status: accepted
aliases: []
tracking: []
---
# D-28 — Engine compatibility surface pinned

Engine compatibility surface pinned: an engine's public contract is exactly five surfaces — exported in-scope functions, registered operations, event types + payloads, permission keys, and entity ids/`EntityRef`s. Table schema is **private**: cross-module SQL reads/writes are lint-banned (boundary-lint R5; one-time extraction handoffs via explicit `boundary-lint-allow` pragma). Evolution is **additive-only**: new operation inputs optional-with-behavior-preserving-default, emitted payload fields frozen once shipped (`schemaVersion` bump + dual-emit window for real changes), permission keys never renamed. Upstreaming from a vertical lands as **new surface, never changed semantics of existing surface**. Operations stay thin (permission check + one exported in-scope function) so verticals extend by composition, not fork

## Why

Breaking-change pressure is how the least-proven hypothesis (27) fails in practice: event breaks are silent until a consumer's runtime parse fails, and raw table reads would make every append-only migration a potential break. Naming the five surfaces makes "be careful" mechanical. Corollary of 19 (star topology), 26 (substates), 27 (extraction discipline)
