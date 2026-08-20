---
'@substrat-run/contracts': minor
---

A read's query string is documented, and a GET no longer claims to take a body (#830).

`buildOpenApiDocument` emitted `requestBody` for every operation declaring an input,
whatever the verb. On a `GET` that describes a call nobody can make — `mountOperations`
never reads a body there — and it left the fields that *do* work undocumented. A paged
list came out like this:

```
/api/customers (GET)
  parameters:  limit, cursor, order
  requestBody: limit, cursor, q, status, customerType, costCentreId
```

`limit`/`cursor` documented twice (the wart #823 acknowledged), and `q`, `status`,
`customerType`, `costCentreId` documented **only** as JSON body properties — so a client
generated from the document could not discover the filters at all, and `?q=…&limit=100`,
the convention that actually works, appeared nowhere.

The split is not new vocabulary: the router already decides it, and decides it by verb —
`takesBody = POST | PUT | PATCH`, everything else reads `c.req.query()`. The builder now
mirrors that rule, so the document and the router describe one surface, which is the point
of deriving both from the same model.

- `GET`/`DELETE` inputs are emitted as **query parameters**, with each field's schema and
  its required-ness, and no `requestBody`.
- A field already named as a path parameter, or by the paged trio the platform writes, is
  not restated — which closes the double-documented `limit`/`cursor` as a side effect. The
  platform's own `limit` survives, so the documented bounds are the real ones rather than
  the operation's bare `z.number()`.
- A single-valued literal is **omitted**: the route pins it and overrides whatever arrived,
  so documenting it would invite a client to send a value that cannot matter.
- Writes are untouched — body as before, no query parameters.

Sharpest on a search route (#827): with no path parameters and no `paged`, `parameters` was
previously *empty*, so `GET /items/search` documented its `q` as a JSON body and nothing
else. `demos/todo`'s two search routes are the visible fix in the re-emitted artifacts.
