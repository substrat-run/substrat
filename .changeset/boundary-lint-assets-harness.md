---
'@substrat-run/boundary-lint': patch
---

`assets.ts` and `assets.generated.ts` join `DEFAULT_HARNESS`. The generated
file is the built SPA inlined as string literals (gen-assets.mjs) — its
`fetch(` is browser code the worker serves, the same edge-wiring class as
`page.ts`. It is also gitignored, so linting it produced local-only R3 reds on
content CI never sees.
