---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/demo-callout': patch
---

A retried write is free — `Idempotency-Key`, the recorded response, and the 409

A client whose request times out does not know whether the work happened. It retries, and
there is a second work order. Agents make this acute rather than novel: they retry more
aggressively than people, and faster. A client now sends a token it chose, and the same
token on the retry returns the first response instead of doing the work again:

```http
POST /api/workorders
Idempotency-Key: dispatch-4471
```

```http
200 OK
Idempotency-Replayed: true
```

**Nothing is declared, which is the difference from #129.** Every operation on an unsafe
method honours the header, because a retried write creating a second entity is a hazard on
all of them — where a lost update is a hazard on the field-bag shape alone, which is why
`concurrency` is opt-in and this is not. The client opts in by sending a key; the server
never requires one. Callout's end-to-end test proves exactly that: a vertical that changed
nothing gets it.

The seam is the one #129 asked for rather than a second interception point beside it.
`InvokeOptions` already said so — *"`If-Match` and `Idempotency-Key` are ONE precondition
pass at one point in the invoke"* — so this declared into that bag, and the mount reads two
headers where it read one.

**The recording is written inside the operation's own transaction**, and three properties
fall out of that placement rather than from mechanisms of their own:

* **A failed request is retried, not replayed.** The operation threw, the transaction rolled
  back, and the recording went with it. Nothing to find, so the retry executes — correctly,
  because nothing happened the first time. Recording failures would have meant deciding
  which of them are permanent, and a retry after a 500 is the most ordinary thing a client
  does.
* **A replayed response describes work that committed.** There is no window in which the
  recording exists and the rows it describes do not.
* **A concurrent retry cannot slip past.** Invocations serialise per scope in both adapters,
  so the duplicate takes its turn after the first has committed. Every other implementation
  of this needs an in-flight state and a "still processing" 409; this one does not, and that
  is a property of the host rather than something to rely on quietly.

Four things this had to get right:

* **A key belongs to the subject that sent it.** Two clients will both choose `1`. The row
  is keyed `(subject, key)`, so a cross-principal replay is not a check someone could
  forget — it is a row that cannot be reached.

* **A key names one request.** The fingerprint is SHA-256 over the operation and its
  **parsed** input — parsed, so a retry omitting an optional field the original sent at its
  default value is still the same request. Same key, different request is `conflict` (409),
  never the earlier response: a client handed an answer to a question it did not ask will
  act on it.

* **Unrecordable fails closed.** A result over 128 KiB records the key with no body, and a
  replay of it is refused rather than executed again. The original did complete, so
  re-running is the one answer that is certainly wrong.

* **An unacknowledged key is refused.** Same shape as #129's skew check and a sharper
  failure: an old ScopeDO that drops `ifMatch` skips a comparison, while one that drops the
  key **runs the operation** and returns 200. The DO acknowledges, and a coordinator that
  sent a key and sees no acknowledgement refuses the success.

**Opting out is a line someone wrote.** An operation whose response must not be recorded —
a freshly minted secret, a one-time token — declares `idempotency: false`, and the host then
refuses the header rather than silently storing the response or silently executing twice.
Opt-out rather than opt-in because the two read differently in a diff: a missing opt-in is
invisible, while `idempotency: false` is something a reviewer can ask about.

Retention is **24 hours**, pruned opportunistically inside the transaction that adds a row —
no sweeper, no second schedule, and a fleet that never sends a key never pays for it. The
window is not only a storage bound: a recorded response is a second copy of what the
operation returned, sitting outside the erasure path that reaches the outbox. A copy that
expires in a day is defensible; one that never expires is a second database of personal data
with no owner.

No new error vocabulary. `conflict` has been in the closed taxonomy since #113, and both
refusals narrow it with a `reason` slug (`idempotency_key_reused`,
`idempotency_replay_unavailable`) rather than inventing a code.

Two things worth knowing about the emitted document. The header is documented on every
unsafe operation rather than per declaration — that IS the surface, and a client made to
work out which writes are retryable will assume none of them are. And it appears only where
`mountOperations` serves the route: Meridian's and Manyfold's `openapi.json` are unchanged
because they hand-write their `/api/op/*` route and pass no options to `invoke`, so
documenting the header there would advertise a behaviour those servers do not implement.

A replay is **not** a fresh authorization — the recorded response is returned without
running the handler, and the permission check lives inside the handler. What bounds it is
that a caller only ever reaches responses it received itself, and that the window is a day.
Stated in `kernel/src/idempotency.ts` rather than discovered, because the alternative —
re-running the operation so the permission can be re-checked — is the duplicate execution
this exists to prevent.

Verified: an 11-case contract suite on both adapters, including across the real ScopeDO hop,
mutation-checked; 4 mount tests; 3 end-to-end HTTP tests against Callout's real route table
proving a retried `POST` opens one work order. Full suite, typecheck, boundary-lint and all
15 generated-file gates green. No migration diff; no permission surface change.
