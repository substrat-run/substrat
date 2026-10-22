---
"@substrat-run/vertical-host": minor
---

Serve `/api/docs` automatically when mounting operations, with a self-hosted renderer under `/api/docs/renderer.js`. The reference reads the app's `/openapi.json` using its existing session and explains authentication failures or unavailable specifications. Apps can retain a previously registered reference or opt out with `docs: false`; no asset build changes are needed.
