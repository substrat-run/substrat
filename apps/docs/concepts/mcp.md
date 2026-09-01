# The MCP surface

Every deployed vertical serves an [MCP](https://modelcontextprotocol.io) endpoint at
`/api/mcp`, and **you write nothing to get it**. If your vertical mounts its operations —
which is how it has routes at all — it has an MCP server, with one tool per operation.

```
POST https://your-vertical.example/api/mcp
Authorization: Bearer <token from your issuer>
```

The point is not that MCP is fashionable. It is that a vertical already declares
everything a tool needs, so the surface is a **derivation** rather than a thing you
maintain. There is no tool registry to keep in step with your routes, and no second file
that can disagree with your model.

## `http` is the declaration

An operation that declares `http` becomes a tool. One that does not, does not.

```ts
'ticket0/configure-desk': {
  summary: 'Change the desk’s settings',        // → the tool description
  permission: 'desk:configure',                  // → the check that still runs
  input: z.object({ greeting: z.string().optional() }),  // → the tool's inputSchema
  http: { method: 'PATCH', path: '/desk' },      // → this is what makes it a tool
}
```

That is the same boundary the [route table](/concepts/api-design) already draws. A
composed engine's in-scope functions carry no `http` — the engine is entity-agnostic and
does not own a URL shape — so they are not routes and they are not tools either.

There is deliberately **no `mcp: true`**. A flag saying "also expose this" would restate a
fact `http` already carries, and the two would part company the first time somebody
renamed a route.

## Exposure is not authorization

This is the property that lets the surface default to on.

Every tool maps to a route that already exists, behind the same bearer verification and
the same `assertAllowed(await ctx.check(…))` inside the operation. Anything an agent can
do through MCP it could already do with `curl` and the same token. The endpoint is a new
**rendering**, not a new door.

Two consequences worth knowing, because they are what a hand-rolled MCP server usually
gets wrong:

- **Authentication is transport-level.** An anonymous call gets an HTTP `401`, which is
  what makes an MCP client start its authorization flow. It is not reported as a tool
  failure.
- **Authorization is in-band.** A refused permission comes back as a normal tool result
  with `isError: true`, so the agent reads *"you may not do that"* and picks something
  else. Returning a transport error there would make one refusal look like a broken
  session.

## Paged reads

A paged read's tool schema names `limit`, `cursor`, `order` and `sort` explicitly.

Over HTTP those ride in the query string and the host supplies them. An MCP call has no
query string, so a paged tool that did not name them would look to an agent like a list
that returns everything — it would pull one page and report it as the whole table. That
is a wrong answer with no error anywhere, which is the failure this platform works
hardest to refuse.

The ceiling behaves as it does on the wire: a `limit` above `LIST_PAGE_MAX` is **refused,
not silently capped**, because a capped page is indistinguishable from the end of a walk.

## The one knob, and it is optional

```ts
'ticket0/record-answer': {
  summary: 'Record an assistant answer and its token usage',
  mcp: false,        // never a tool, for anyone
  http: { method: 'POST', path: '/turns' },
}
```

`mcp: false` is for operations that face the network because *a machine* posts to them —
a connector's return path, a relay's ingest, a widget service's surface, a schedule's
entry point. They are reachable over HTTP for good reason and are pure noise in an
agent's tool list.

The other half of the knob is a description:

```ts
mcp: { description: 'Search the knowledge base. Use before answering any question.' }
```

`summary` is written for an API document — it answers *what is this*, where tool
selection needs *when would I reach for this*. Say more only where the difference bites.
A new vertical writes neither of these.

## What this does not solve

**Tool count.** ticket0 routes 59 operations; marking its machine-facing ones leaves 46
tools, which is still a lot to put in front of a model. Two things will help, and it is
worth being clear that neither is here yet:

- **A permission filter** on `tools/list`, so a caller is not offered what they cannot
  call. This is a least-privilege floor rather than a curation mechanism — dramatic for a
  narrow principal, marginal for an admin. ticket0's `desk-admin` holds 16 of its 19
  permission keys, so filtering would barely shorten *its* list.
- **Per-consumer app scoping**, which is where a *coherent* toolset actually belongs. A
  triage agent and a reporting agent want different subsets of the same vertical while
  holding the same principal — and that is a fact about the consumer, which neither the
  model file nor the permission spine can express.

Filtering `tools/list` is invisible to the protocol, so both drop in later without
breaking a client.

## Turning it off

```ts
mountOperations(app, myOperations, resolveStub, { mcp: false });
```

Or configure it:

```ts
mountOperations(app, myOperations, resolveStub, {
  mcp: { path: '/mcp', serverInfo: { name: 'ticket0', version: '1.4.0' } },
});
```

The server name defaults to the module prefix your operations share (`ticket0/get-desk`,
`ticket0/list-agents` ⇒ `ticket0`), so it cannot drift from what the tools are called.

## What the endpoint speaks

Stateless [Streamable HTTP](https://modelcontextprotocol.io/specification/basic/transports):
one `POST` per JSON-RPC message, answered as `application/json`. `GET` returns `405` —
this server opens no server-to-client stream, because every tool is a request/response
call into a scope and there is nothing to push.

Protocol revisions are negotiated, newest first: `2025-06-18`, `2025-03-26`, `2024-11-05`.
A client asking for one we do not implement is answered with ours rather than an echo of
theirs, and decides for itself whether to continue.

Implemented: `initialize`, `ping`, `tools/list`, `tools/call`. Resources and prompts are
not — `tools` is the whole capability today.
