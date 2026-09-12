---
'create-substrat': patch
---

The scaffold template's route layer is derived from its operations, the way the reference verticals do it. Each operation in `src/operations.ts` declares its `http`, the two composed engines are bound with `defineEngineRoutes`, and `src/routes.ts` mounts the result with `mountOperations` — so the hand-written table and its two page helpers are gone, a paged read's `Link` walk comes with the derivation, and a `{var}` naming no input field is a compile error rather than a route that 404s.
