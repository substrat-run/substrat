---
id: K-62
date: 2026-11-18
layer: kernel
title: "An operation does not await an outside call inside its transaction; an exchange that decides a commit is an attempt committed before the request leaves"
status: proposed
aliases: []
amends: []
tracking: ["#3289"]
---

# K-62 — An operation does not await an outside call inside its transaction; an exchange that decides a commit is an attempt committed before the request leaves

> Proposed, not accepted. It answers #3289, a regulated cash register that needs a control code
> before a sale is registered, and it turns down that issue's `ctx.call` port. The design, the
> regulation's text and the open questions are in [rfc/synchronous-port.md](../rfc/synchronous-port.md).

**`OperationContext` gains no request/response verb, and an operation never awaits a call to an
outside service inside its transaction.** R3 stays as it is. No host runs third-party I/O between an
operation's `BEGIN` and its commit.

**An exchange whose answer decides a commit takes two transactions, with the call between them in
host code.** The engine first commits an **attempt**: what it reserves (a receipt number, say), the
request exactly as it will be sent, and a journal entry for it. That commit happens before the
request leaves. Host code in the vertical's worker then makes the call, under the declared `outbound`
of D-46, within a time budget. A second operation then either records the answer (the receipt, its
counters and its journal entries in one transaction) or abandons the attempt and journals the
failure. A late answer to an abandoned attempt is refused and journaled, never applied.

**The engine holds the order, whoever drives it.** It hands out an attempt's request **once**, with a
send token, from the transaction that creates the attempt. A duplicate or a retry gets the attempt's
state, never the request, so the host's idempotency replay is not used for that step. It refuses a
record or abandon without the token, a second open attempt on the same unit, and a receipt without a
code. It also abandons an expired open
attempt, as "outcome unknown", before opening the next one. A driver that misbehaves can stall one
unit until its attempt expires, but it cannot break the series or skip the journal.

## Why

**The in-transaction call loses the record it was meant to keep.** The regulation requires that what
a register sends to the control unit and receives from it be registered (SKVFS 2014:9, 4 kap. 9 §).
A call that throws inside the transaction rolls back the journal row of a request that has already
left. A crash after the request left leaves nothing durable that knows it was sent. Committing the
attempt first is the only shape where every exchange is on record, including one that failed.

**Holding the transaction across the call costs every other caller.** Both hosts serialize a scope's
operations (K-6), so every other till and every read on the scope would wait out the control unit's
round trip. On the Durable Object, Cloudflare doesn't document what an outbound `fetch` does under an
open async `transaction()` while output gates hold requests behind pending writes, and this repo has
never probed it. A call from the scope DO also bypasses D-46's egress enforcement. A call from the
worker does not.

**A kernel lifecycle that stages the call between two transactions gives the same guarantees at a
cost every vertical pays.** It is recorded as the shape to revisit if a second consumer needs the
kernel itself to enforce the order, or if the platform takes custody of the credential the call
needs. Neither holds today, and the engine's own state machine already refuses every order the
regulation forbids.
