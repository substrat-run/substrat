---
'@substrat-run/contracts': minor
---

`buildOpenApiDocument` + `ApiCatalog`: a vertical exports an operation catalog (operation name → summary + the same Zod schemas its handlers parse) and gets an OpenAPI 3.1 document — served live at `/openapi.json` and checked in via `pnpm lint:api` (design/api-surface.md). Uses Zod 4's native draft-2020-12 emit; no new dependencies.
