---
id: K-51
date: 2026-10-15
layer: kernel
title: "The assistant's record is an engine composed by call; the run is host code, written by a key no person holds"
status: proposed
aliases: []
amends: []
tracking: ["#2283"]
---

# K-51 — The assistant's record is an engine composed by call; the run is host code, written by a key no person holds

**The assistant RFC ([#2284](https://github.com/substrat-run/substrat/pull/2284)) puts a chat between a person and an assistant in every product.** This records the one placement decision its first build needs, which is who owns what: the conversation's record is an engine, `engine-assistant`, and the loop that produces it is not.

**The engine owns the record and its invariants, and never talks to a model.** Module code has no network, no streaming and no clock of its own, so it cannot run a loop. A host (the platform's assistant host, or a vertical composing the engine) runs the loop and calls the engine's in-scope functions to write what happened. This is the by-call shape of workorder, booking and notifications: the vertical or host composes exported functions in its own transaction. Five things are guaranteed in the engine, because they are invariants and not conventions:

- the record is append-only and numbered per thread, and the number is the cursor a client resumes after;
- the assistant's side is written only by the holder of a single-writer lease, and the holder is fenced at every append, so a run replaced while still running cannot write;
- a tool call that asks for approval is bound to `approvalDigest` of a tagged tuple (deployed version, approver, thread, step, call, operation, expiry, nonce, input; the RFC's §6.0 point 3): the approval is accepted only when the digest recomputed with the answering principal and the answering version matches, before the expiry, the execution is claimed once and only with the operation, version and input that recompute to it, before the expiry, both moves are conditional writes, and a result for a gated call is refused unless it was claimed;
- an event is bounded, so a large tool result lives in the operation that produced it and is referred to by id, not copied into a Durable Object row;
- every table that holds what a person said, or whose thread it was, declares its erasure by delete (K-46).

**Two keys, and no person holds the second.** `assistant:use` is the person's: open and read their own threads, say something, approve or deny. `assistant:run` is a system principal's (the host's), never a role a person holds: take the lease, append the assistant's events, claim an execution. Even it writes only inside a turn the person opened, so a run cannot hold a resting thread and lock its owner out. Nothing refuses a person's role that grants it yet; whether `lint:permissions` should is left open. If a person held it they could append events to their own thread and have the record say the assistant wrote them, or mark a tool call done that never ran. The split is what makes the record evidence. `assistant:audit` widens a read to other principals' threads and never a write. A thread belongs to the principal that opened it; a stranger is told it does not exist.

**The platform learns milestones, not deltas.** Six events (thread created, turn started and finished, approval requested and resolved, thread closed), none carrying text, tool input or output, an approval's digest or preview, or the owner's id. Each is `pseudonymous` with the thread's owner as its `subjectId`, so an erasure redacts its payload; what stays is the envelope the kernel keeps for every erased event. This is a deliberate reading of "every mutation emits a fat event": the per-delta rows are the engine's own record, and an outbox row for each of forty text deltas would be that record written twice. The reading is stated here so a reviewer can refuse it.

## What it does not decide, stated

Where a live thread runs (the RFC's spike recommends a Durable Object per thread over a placement-agnostic loop, to be confirmed deployed), the stream protocol's wire format (owned in `contracts`, #2304), how a vertical is given the thread object, memory, the support handoff, and message branches. Each is additive to this engine: a column, an event type, a table.

## Why

**The invariants need a transactional record that every host shares.** An approval bound to an input digest, a single claimed execution, a fenced writer and an erasure that reaches the person's words are each a property of the rows and the transaction around them. If each product that wants a chat wrote its own, each would write its own approval check, and the one that gets the digest comparison wrong lets a model change the arguments of a write the user agreed to. That is the failure a human cannot see from the screen. An engine is where this repo already puts "an invariant that a vertical must not be able to get wrong".

**By call, because the loop cannot live in an engine.** The loop needs the network, streaming and a model, none of which module code has, and the model call is seconds long, so holding a scope's transaction open across it is exactly what the no-network rule exists to prevent. The host runs the loop outside any transaction and writes each result through the engine inside one. The same engine is therefore usable by the dashboard, by a vertical, and by a support desk, with the host varying and the record not.

**Two keys, because the record is only evidence if the assistant's side cannot be forged.** The user's side is something the user did; the assistant's side is something the host did. Letting one key write both would make every thread a claim rather than a record, and the first place that matters is an audit of what an assistant did to a customer's data.

**Milestones rather than deltas, and nothing of the person's on them.** The words are the person's and live on rows an erasure deletes. An erasure redacts a pseudonymous event's payload in the scope, but a copy that has already left (a consumer's projection, an export) is out of its reach, so an event carries nothing of the person's to begin with: not the words, not a digest of the input (a hash of a small input is recovered by guessing it), not the owner's id. Putting a row on the outbox for every delta would write the record twice.
