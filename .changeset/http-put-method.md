---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
---

`http.method` accepts `PUT` (#777).

The union was `GET | POST | PATCH | DELETE`, with no comment defending the exclusion and no
semantic argument recorded for it — the demos that shaped it happened not to use `PUT`. A
vertical with live `PUT` routes therefore could not declare them, and its choice was to break
25 production URLs by redeclaring them `PATCH`, or to keep the hand-written route table that
`mountOperations` exists to delete. Neither is a trade an enum omission should force.

Widened at all four sites — the operation shape, the engine route bindings, the OpenAPI
catalog, and the host's route derivation — plus the two branches that read the method:
`PUT` carries a body like `POST`/`PATCH`, and `mountOperations` now dispatches it to
`app.put`. Purely additive: widening an accepted union breaks no existing declaration, and a
vertical that does not use `PUT` sees no change.
