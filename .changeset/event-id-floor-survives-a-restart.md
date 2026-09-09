---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

The monotonic floor an event id is minted above now survives the process that held it.
It used to live only in memory, so a host that closed and reopened — or a scope's
Durable Object evicted and revived, which happens constantly — began again from the
clock alone. If that clock had stepped backwards since (an NTP correction is small but
real), the next id sorted *underneath* rows already in the outbox, and a reader paging
`id > <last seen>` was never handed them. Both adapters now seed the floor from the
scope's own persisted maximum when the scope is opened, so the next id clears what is
on disk whatever the clock says. The floor is also per scope rather than per host,
which is the scope `ORDER BY id` is defined over: a busy scope no longer drags a quiet
one's ids forward. `@substrat-run/kernel` gains `UlidMint.seedFrom(id)` — raise a
mint's floor to an id already stored, never lowering it, refusing anything that is not
a ULID.
