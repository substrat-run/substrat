# Findings: where a live assistant thread runs

Run locally on macOS, 14 to 15 October 2026. `node run.mjs` (miniflare 4.20260730.0, workerd,
Node 22) has 41 assertions, and 43 with `SLOW=1`; the run history, corrected, is below. `node bundle.mjs`
(esbuild 0.25.10, Lit 3.3.1) measured the element. No Cloudflare account, no deploy, no real
model.

**A correction to the run history.** The first version of these findings reported ten clean
runs and called an earlier 40 of 41 "an unexplained blemish". It had a cause. A reviewer got
40 of 41 on two of five runs, both times on `B: event type sequence equals A`: step 2 wrote 8
`text-delta` events in A and 9 in B, because the loop's 50 ms coalescing (`src/loop.mjs`)
decides how many deltas a step writes, and that depends on timing. The rendered text was
identical in both (`B: full render equals A` passed), so correctness was never in question;
the assertion compared something timing-dependent. It now compares the sequence with each run
of `text-delta` collapsed to one, and the render is still compared exactly. One other early
run printed no summary line at all; its output was not kept, so its cause is unknown. After
the fix, and a second one to the test client, the suite passed 41 of 41 on ten consecutive
runs on 15 October 2026 (see [the run record](#run-record-after-the-fix)).

## What was built

Two placements behind **one event protocol and one turn loop**, so that the only things that
differ are who holds the run and how a client attaches:

- **A. The request.** The run lives in the request that started it (`ctx.waitUntil`). A client
  attaches over SSE. A client that returns later tails the record by polling every 100 ms.
- **B. A Durable Object per thread** holding a hibernating WebSocket and the run, with an alarm
  as a watchdog.

Both write to a **record**: an append-only event log and a single-writer lease with a
heartbeat, standing in for `engine-assistant`. Events are written first and delivered second.
The loop reads the record to decide its next step, so a turn is resumable from the record
alone. The model is scripted and deterministic (look up sessions, propose a gated write, wait
for approval, execute, conclude) with configurable delay.

## Shown (assertions)

1. **Resume is exact in both placements.** A client cut off mid-answer reconnects with the last
   id it saw and receives exactly the next event. The seen and resumed events are contiguous,
   with no gap and no duplicate, and render to the same text as an uninterrupted run.
2. **The run survives the client leaving**, in both, for a run of a second or two (S2).
3. **Approvals work across a gap and are bound to the input.** An approval carrying a digest of
   a different input is refused (`400` / `digest_mismatch`), approving twice in sequence is
   refused (`409` / `already_resolved`), a denial skips the tool, and an approval 1.5 s later
   from a fresh connection is accepted. This shows that whoever approves cannot change the
   arguments after the approval was given. It does **not** show that the approver is the
   user: see "Not shown".
4. **A dead holder is fenced.** A holder that lost the lease cannot append, and the takeover is
   reported as a takeover. This is what makes two places able to run a turn safely.
5. **Two sends at once start one turn.** The other gets `409` (A) or `busy` (B).
6. **A run cut off mid-step is recovered correctly.** The loop announces a `step-restart` so the
   client drops the partial text of that step, and the recovered render equals the
   uninterrupted one. A run cut off on a step boundary needs no marker.
7. **Both placements recover a dead run**, but by different means and at different times (below).

## Measured (local, so relative)

Numbers vary with machine load. Ranges are across the ten runs of the first version of these
findings (14 to 15 October), not the later batches in the run record; other workerd processes
were running on the machine.

| | A: request | B: Durable Object |
|---|---|---|
| Platform overhead to the first text token (model adds a fixed 300 ms) | p50 7 to 33 ms | p50 4 to 19 ms |
| One call from the worker to the record | 1 to 6 ms | 1 to 6 ms |
| Lag of a second client attached to a live run | p50 57 to 91 ms, p95 75 to 102 ms (bounded by the 100 ms poll) | about 0 ms (a push) |
| A dead run, a client returns at once | resumes after **about 3.1 to 3.2 s** (the lease staleness, set to 3 s) | not timed; the code recovers on attach without waiting, because the object knows its own previous run is dead |
| A dead run, **nobody returns** | **stays dead**, checked at 4.5 s | **recovered by the object's alarm**, 2.7 to 2.8 s after the reset, with no client |
| A dead run, a client returns after the lease went stale | resumes in about 105 ms | n/a |

The overhead is dominated by the serial record writes that precede the model call (lease,
user message, step start, text start), one record call each. It is the same for both
placements and is a property of persisting before delivering, not of where the run lives.
Starting the model request concurrently with those writes, and sending the structural events
before the first token as one batch, would remove most of it. That is a cheap change to make
in P1.

**What a long answer writes** (400 words, scripted):

| Batching window | Rows | Bytes | Record calls | Frames to the client |
|---|---|---|---|---|
| none (one row per token) | 433 | 20.3 KB | 432 | 433 |
| 50 ms, leading edge | 41 to 44 | 4.6 KB | 38 to 41 | 41 to 44 |
| 250 ms | 21 to 22 | 3.8 KB | 18 to 19 | 21 to 22 |

Merging deltas inside a short window cuts a long answer by about ten times in rows and calls.
The leading edge matters: the first token after a quiet spell goes out at once, so the window
costs the user nothing on the first token. Rows stay small, so the Durable Object row ceiling
is a concern only for large tool results, which the RFC already stores by reference.

**Shipping weight** (minified, gzip): Lit alone 5.7 KB; the headless client alone 0.9 KB; the
spike element with client and Lit 7.5 KB (0.8 and 7.4 KB before the client learned to resume a
stream that closes cleanly mid-turn and to read a refusal as one). The shipped element will be
larger (markdown, the approval preview, branches, the memory view, the renderer registry), so
7.5 KB is a floor.

**Hibernation (B, `SLOW=1`).** An object holding one idle socket was constructed again after
25 s (the constructor counter went from 1 to 2), and the old socket still carried a turn
afterwards. So on local workerd the socket survives the object leaving memory, and the loop
needed nothing in memory to continue.

## Not shown, and why it matters

- **That the user approved.** The approve endpoints take no principal: `approve` in
  `src/worker-a.mjs` and the `approve` message in `src/worker-b.mjs`'s `webSocketMessage` accept
  any caller who knows the thread name. So the spike binds an approval to the *input*, not to
  the *person*, and the model's own credential could have approved. That is the gap the RFC's
  §6.0 closes: an approval arrives on a user-presence route the loop cannot call, and binds
  the approving principal, thread, call, operation, expiry and a nonce.
- **Single-use under a race.** "Approving twice is refused" was shown in sequence only. The
  check is check-then-act: `worker-a.mjs` reads the record for `already_resolved`, then
  `startRun` takes the lease and appends `approval-resolved` without checking again;
  `worker-b.mjs` does the same across an RPC to the record object. Two approvals arriving
  together could both pass the check. Found by reading, not reproduced. In P1 the single-use
  and digest checks belong inside the record's own conditional append.
- **A real digest.** `digestOf` (`src/protocol.mjs`) is SHA-256 over `JSON.stringify` of the
  input. That is not a canonical encoding: it depends on key order. It is harmless here because
  both sides hash the same stored object, but P1 needs a canonical encoding (or a digest over
  the stored bytes), tagged with what it binds, so the same input for two operations or two
  threads does not give the same digest.

- **The 30 s `waitUntil` cap did not reproduce.** The documentation says `waitUntil` extends
  execution for up to 30 seconds after the response is sent or the client disconnects. In `SLOW`
  mode a 32 s run in A, started and abandoned by the client at once, **completed** locally. So
  local workerd does not enforce the cap, or it did not apply to this shape, and this spike
  cannot confirm it either way. The documentation is the only evidence, and it is clear. If it
  holds, placement A silently truncates any turn that needs more than 30 s after the client
  leaves, which a multi-tool agent turn can.
- **Real eviction.** `ctx.abort()` simulates a reset: the socket closed after about 17 to 58 ms
  and the object was constructed again, as with a redeploy or a host move. I did not see an
  eviction from idle on a deployed object, or a runtime-update grace period.
- **Idle cost.** Not measurable locally. From the documented prices (duration $12.50 per million
  GB-s at 128 MB; requests $0.15 per million; an object that is idle and eligible for
  hibernation is not billed for duration): an active turn of 30 s is 3.75 GB-s, about $0.00005;
  10,000 turns a day of 30 s each is about 1.1 million GB-s a month, about $9 after the 400,000
  included. Polling in A at 10 requests a second for a 30 s attached turn is 300 record
  requests, about $0.00005 per turn, about $13 a month at 300,000 turns. Both are small next to
  the model's own cost per turn. This is arithmetic from a price page, not a measurement.
- **The real record.** The record here is a raw SQLite append, not an engine operation invoked
  through `stub.invoke` with a permission check, events and the outbox. The per-append cost of
  the real path is unmeasured, and it is what the first-token overhead is made of.
- **A real model and a real network.** Time to first token for a user is the model's, plus
  this overhead, plus the network. Nothing here says what that adds up to.
- **How the object is provided to a vertical.** The spike declares its own classes. In the
  platform the options are a platform-run object per scope (the scope-stores proposal) or a
  class the uploader supplies, as it already does for the scope sweeper (`SweeperDO`, #1902).
  Not tried.
- **The element in a browser.** `bundle.mjs` measures size only. The element was never rendered,
  and its screen-reader behaviour is untested.

## What this means for the RFC's Q2

1. **The placement is not the load-bearing choice.** The record, the lease with fencing, and a
   loop that decides its next step from the record are. With those, both placements passed
   every correctness assertion, and the same loop ran in both unchanged. That is worth more
   than the choice itself, because it means the placement can change later without touching
   the engine, the protocol or the clients.
2. **B is the better coordinator, for reasons that are about the product, not speed.**
   - **A reply that arrives from outside any user request** (a human agent answering after a
     handoff, the support case in the RFC) has nowhere to be pushed from in A except a client
     polling the record. B has a live place to push to.
   - **A run that dies with nobody watching stays dead in A** until the user returns, and
     returns to a half-finished answer. B finishes it, and can then notify the user.
   - **A's run is limited by `waitUntil` to 30 s after the client leaves**, per the docs. B's
     pending I/O keeps the object alive for up to 15 minutes per operation, per the docs.
   - A's polling tail costs a request per poll and lags by up to a poll interval; B's push does
     neither.
3. **A is enough for a short chat that needs none of that**, and it needs nothing new
   deployed. If the first consumer's turns are short and there is no human participant yet,
   A is a legitimate first step, because the loop and the record are the same.
4. **Recommendation:** build the loop and record placement-agnostic (P1, as the RFC already
   says), implement **B** as the live coordinator, and treat A as the fallback shape rather
   than a second implementation to maintain. Prove it deployed (P0b) before relying on it.

## P0b: what to measure next, deployed

1. The 30 s `waitUntil` cap on A, with a 40 s run and the client gone.
2. Time to first token and the per-turn overhead with a real model through the real model host,
   from a cold object and from a warm one.
3. Eviction from idle, a redeploy while a turn is running, and the recovery that follows.
4. The cost of the real `stub.invoke` append against the raw one.
5. Idle cost of a day of idle sockets, from the usage dashboard.
6. Whether the supplied-object route (as for `SweeperDO`) or a scope-store kind is the way a
   vertical gets the thread object.
7. The element in a real browser with a screen reader.

## Run record after the fix

15 October 2026, `node run.mjs`, with other workerd processes on the machine:

- **First batch of ten (sequence assertion fixed):** 9 passed 41 of 41. Run 8, at a load average
  of about 61, failed a different assertion, `A: run completed with no client attached`, and then
  threw. The cause was the test client, not the run: after `abort()`, `sseClient`
  (`src/client.mjs`) kept recording the frames already buffered in the same chunk, and under load
  one chunk held the rest of the phase, so the "last id seen" was the end of the phase and there
  was nothing to resume. The client now stops at the disconnect.
- **Second batch of ten (both fixes):** 10 of 10 passed 41 of 41, at load averages from about 55
  falling to about 9.
- **Third batch of five (after the client learned that `turn-error` ends a turn):** 5 of 5
  passed 41 of 41, at load averages from about 8 to about 54. The gzip sizes did not change.
