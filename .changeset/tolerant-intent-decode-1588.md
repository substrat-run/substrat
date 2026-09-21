---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': patch
---

One malformed platform-intent row no longer makes a scope's whole intent list unreadable.

Every read of a scope's intent journal returns a list — the drain's pending queue, the
journal history, and `ctx.platformRequests` inside an operation — and the row decode behind
all three was strict. A single row whose JSON would not parse therefore threw for the whole
scope: the drain could not read its own queue, and the history read, which exists so a
failed intent explains itself afterwards, was switched off by exactly the row that failed.
Module code cannot write such a row, but a restore replays a dump's rows verbatim, so a dump
from another world or one edited by hand was enough.

The reads are tolerant now, and say so. A row that does not decode is returned beside all
the others with a new optional `decodeError` naming every column that failed, and each of
those fields comes back empty — `null`, or a self-naming marker for the requester — rather
than guessed at. Every value a read returns still satisfies the published `PlatformRequest`
schema: a row whose id, kind, status, attempt count or request time is itself corrupt has no
honest empty value to fall back to, and is still refused as it was. A row the platform wrote
carries no `decodeError` at all, so a healthy list reads exactly as it did before. The three
copies of the decoder are now one, in the kernel (`platformRequestOf`).

The drain stays strict where it acts. A row carrying `decodeError` never reaches a handler:
it is settled `failed`, attributed to the platform, with the decode failure in its
`lastError`, and lands as a terminal ops failure like any other refusal.
