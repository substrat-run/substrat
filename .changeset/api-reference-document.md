---
'@substrat-run/vertical-host': minor
'create-substrat': patch
---

`mountOperations` serves the OpenAPI document its `/api/docs` page renders, at `/api/openapi.json`, derived from the operations it mounts and read through `resolveStub`. The page read a root `/openapi.json` that the template and every generated app never served, and that a dev server's Vite proxy and a hosted app's worker-first routes did not reach, so the reference said the specification was unavailable. `docs: { info }` names the derived document, and `docs: { document }` serves one the app already builds.
