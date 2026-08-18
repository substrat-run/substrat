---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
---

Engine route binding, and an API document derived from the model.

**`defineEngineRoutes`** — a vertical declares where a composed engine's
operations live in its own API. An engine declares no `http` and should not: it
is entity-agnostic and does not own a URL shape, since a bike shop calls the same
work order a repair. That left a composing vertical hand-writing most of its
route table — 17 of Callout's 27 routes. Every `{var}` is checked against the
engine's input schema, so a path naming a field the engine does not accept is a
compile error rather than a silent 400.

The operation NAME cannot be checked at compile time: `ModuleRegistration` types
its operations as `Record<string, OperationHandler>`, erasing the keys before a
vertical can see them. `mountOperations` gains `knownOperations`, so a typo fails
at mount with a message naming it instead of as a 404 the first time somebody
calls that endpoint.

**`apiCatalogFrom`** — the OpenAPI catalog, read off the declared operations
rather than restated. Meridian's hand-written catalog is 226 lines and
Manyfold's 184, all of it repeating what the model already says. `tag` and
`description` stay supplied, the same prose/derived split as
`manifestOperations`.

**`ApiOperationDoc.http`** — the document now describes the route the server
actually serves. Before operations declared `http`, the only shape available was
the platform's `/api/op/{name}` invoke convention, so a vertical serving REST
routes published a document describing a surface it did not have. Path
parameters are emitted as OpenAPI `parameters`, and several operations sharing a
URL merge into one path item. Verticals whose catalogs declare no `http` are
byte-identical to before.
