---
'@substrat-run/vertical-host': minor
'@substrat-run/contracts': minor
---

A vertical now serves an MCP endpoint, and writes nothing to get it. `mountOperations` renders the operations it is already mounting a third way — REST, OpenAPI, and now one MCP tool per operation at `${basePath}/mcp` — dispatching through the same `resolveStub` and the same permission checks. `http` is the declaration: an operation that faces the network is a tool, one that does not is not, and there is no `mcp: true` to restate a fact the route already carries. Descriptions come from `summary`, input schemas from the declared Zod object, and read-only/destructive hints from the method.

It defaults on because it adds no reachability: every tool is a route that already existed, behind the same bearer verification and the same `assertAllowed(ctx.check(…))`. What that buys is a split a hand-rolled server usually gets wrong — authentication stays transport-level, so an anonymous call is an HTTP 401 that starts a client's authorization flow, while authorization is in-band, so a refused permission is a readable tool error the agent can work around rather than a broken session. A paged read's tool schema names `limit`/`cursor`/`order`/`sort` explicitly, since an MCP call has no query string to carry them and a list that looks unpaged is read as a whole table.

The one knob is optional and per operation: `mcp: false` keeps a machine-facing route — a connector's return path, a relay's ingest, a widget service's surface — out of the tool list, and `mcp: { description }` says more than an API-document summary where tool selection needs it. A new vertical writes neither. `mountOperations(…, { mcp: false })` turns the endpoint off entirely.
