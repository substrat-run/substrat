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

**A kernel-composed (`ctx.page`) cursor carries its walk, `<order>.<sort>.<position>`, and a cursor replayed in a different walk is refused**, as `validation_failed` with `reason: 'cursor_restart'` (`PAGE_CURSOR_RESTART`), whose remedy is always to read the first page again. A bare position, minted before this, is continued in the one walk every such cursor came from (ascending, by the first declared sort) and refused anywhere else. This amends K-41's "nothing in a cursor says which sort issued it". Cursors stay opaque to a caller: hand back `nextCursor`, or follow `Link`.

## Why

Until #2001, `paged.order` was read by one consumer, the OpenAPI emitter, which advertised it as the parameter's default. The route forwarded `order` only when a caller sent one, and `ctx.page` fell back to `asc`, so six reads declared newest-first were served oldest-first. Ticket0's inbox, for one, walked its whole closed history before reaching a live conversation. The default belongs where the operation is known. The list plan is per entity, and two operations may page one entity in opposite directions, so it cannot carry the default. The input parse is per operation and is the one step every door already shares.

Honouring the declaration changed the default walk under cursors already in flight, which is exactly the replay K-41 left to convention. A keyset position replayed in the other direction turns `created_at > ?` into `created_at < ?` over the same value, and the "next" page is the rows the caller has already read. That page looks like a working list. A position replayed under another sort compares values from two different columns. K-41 declined to encode the sort into the cursor because encoding would cost a cursor's legibility: no encoding, survives a query string, debuggable by eye. A readable prefix keeps all three, so the reason no longer holds and the server can refuse instead of guessing. The pre-#2001 position is accepted where it is unambiguous, so a walk in flight across the deploy keeps going. It is refused where it would replay silently, above all under a newly honoured `desc`, and that costs one restarted walk at the boundary.

A handler-composed (`sortKey`) walk mints its own cursor and is unchanged: it still relies on the `Link` header carrying `sort` and `order` along, as K-41 described.
