---
id: K-44
date: 2026-10-04
layer: kernel
title: "A paged read is served in its declared order, and its cursor names the walk that minted it"
status: proposed
aliases: []
amends: ["K-41"]
tracking: ["#2001"]
---

# K-44 — A paged read is served in its declared order, and its cursor names the walk that minted it

**A paged read's declared `order` is the direction a caller gets by naming none, on every door.** It is applied where the host parses every invocation, `operationInputsOf`, so the route, MCP, an in-process `invoke`, a seed and a schedule all agree, on both adapters, and no handler or door restates it. An explicit `order` still wins. Where nothing declares an order the field stays absent, so a handler-composed (`sortKey`) read's own fallback still decides.

**A kernel-composed (`ctx.page`) cursor is an opaque, versioned envelope that names its walk: base64url of `{ v: 1, order, sort, value, id? }`, every field validated when it comes back. A cursor replayed in a different walk is refused**, as `validation_failed` with `reason: 'cursor_restart'` (`PAGE_CURSOR_RESTART`), whose remedy is always to read the first page again. A cursor minted before this is recognised only by its exact old shape, `<value>|<ULID>` (a bare ULID where the walk is by id). It is continued in the one walk every such cursor came from (ascending, by the first declared sort) and refused anywhere else, as is anything that is neither shape. This amends K-41's "nothing in a cursor says which sort issued it". Cursors stay opaque to a caller: hand back `nextCursor`, or follow `Link`.

## Why

Until #2001, `paged.order` was read by one consumer, the OpenAPI emitter, which advertised it as the parameter's default. The route forwarded `order` only when a caller sent one, and `ctx.page` fell back to `asc`, so six reads declared newest-first were served oldest-first. Ticket0's inbox, for one, walked its whole closed history before reaching a live conversation. The default belongs where the operation is known. The list plan is per entity, and two operations may page one entity in opposite directions, so it cannot carry the default. The input parse is per operation and is the one step every door already shares.

Honouring the declaration changed the default walk under cursors already in flight, which is exactly the replay K-41 left to convention. A keyset position replayed in the other direction turns `created_at > ?` into `created_at < ?` over the same value, and the "next" page is the rows the caller has already read. That page looks like a working list. A position replayed under another sort compares values from two different columns. K-41 declined to encode the sort into the cursor because encoding would cost a cursor's legibility: no encoding, survives a query string, debuggable by eye. This gives up the third. A readable prefix such as `asc.name.` was tried first and kept all three, but it could not be told apart from a legacy cursor whose sort value began the same way: a row named `asc.name.foo` minted exactly that cursor, and the walk bound `foo` (#2018 review). base64url never emits the `|` a legacy composite carries, and a ULID can never decode to the `{` an envelope starts with, so the two are distinct by construction, not by a guess about what values look like. The envelope still survives a query string untouched, and reading one by eye is a single base64 decode. The pre-#2001 position is accepted where it is unambiguous, so a walk in flight across the deploy keeps going. It is refused where it would replay silently, above all under a newly honoured `desc`, and that costs one restarted walk at the boundary.

A handler-composed (`sortKey`) walk mints its own cursor and is unchanged: it still relies on the `Link` header carrying `sort` and `order` along, as K-41 described.
