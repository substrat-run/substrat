---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/model-emit': minor
'@substrat-run/demo-callout': patch
---

A read-modify-write says what it is writing over — `concurrency`, `If-Match`, and the 412

Two people open the same record, both save, and the second write destroys the first. No
error, no log line, and nobody notices until the data is gone. An operation that is
read-modify-write now declares what it is writing over:

```ts
'callout/update-facility': {
  input: z.object({ facilityId: z.string(), name: z.string().optional(), … }),
  concurrency: { over: 'facility', idFrom: 'facilityId' },
  emits: { entity: 'facility', entityIdFrom: 'id', type: 'callout.facility-updated', … },
  http: { method: 'PATCH', path: '/facilities/{facilityId}' },
}
```

One declaration, three consequences. Every response carries the entity's version as an
`ETag`. An unsafe method compares the caller's `If-Match` against that version **inside the
operation's transaction** and refuses a stale one with `precondition_failed` (412). The
generated browser client remembers the tag a read handed back and sends it on the next
write to that entity, so an app writes no header code.

No new error vocabulary: `precondition_failed` → 412 has been declared in the taxonomy
since #113, excluded from `DOCUMENTED_ERROR_CODES` precisely so it would appear when
something could raise it. It now joins the emitted document **per operation** — on the ones
that declared `concurrency` and nowhere else.

**Opt-in, and not left to memory.** Most declared operations are command-shaped:
`todo/rename-list` takes a name, not a whole entity it read and echoed back, and two
concurrent renames do not lose an update. But the shape that *does* lose them is visible in
the model — one required field naming the row, every other field optional over that
entity's own columns — and an operation of that shape with no `concurrency` is refused at
module load, as a bare-array list output with no `paged` already is. It matches nothing in
the fleet today, which makes now the cheapest moment it will ever be added.

### Three things the implementation had to get right

**A guarded operation must emit.** An entity's version is the ULID of the last event about
it (#901) — there is no version column. So a guarded write that announces nothing is worse
than an unguarded one: both writers pass their `If-Match`, neither moves the version, both
commit, and both receive a 200 with an `ETag` asserting the write was serialised.
`concurrency.over` is compile-checked against the operation's declared `emits`, which is
the check `entity-version.ts` asked for by name.

**The permission answers before the precondition.** The version is snapshotted before the
handler (its own `emit` moves it) and compared *after* — because the permission check lives
inside the handler, and refusing on the version first turns any guarded operation into an
oracle: a principal with no permission on the entity sends `If-Match: *` and learns whether
it exists, or sends a tag and learns whether it changed. Found by driving Callout's
two-tab scenario over real HTTP as a technician, which answered 412 where it owed 403.

**An unacknowledged precondition is refused, not assumed.** Every previous argument added
to the coordinator↔ScopeDO RPC was safe for an old DO to ignore — dropping
`failureEnvelope` makes it throw, which the caller handles. Dropping `ifMatch` would commit
the write and return 200 with nothing compared. So the DO acknowledges that it evaluated
the header, and a coordinator that sent one and sees no acknowledgement refuses the success
rather than reporting a conditional write that was never conditional.

### What each package gained

- **contracts** — `concurrency` on `OperationShape`; `assertConcurrencyMovesVersion` and
  `assertFieldBagsDeclareConcurrency` at module load; `operationConcurrencyOf`;
  `ETAG_HEADER` / `IF_MATCH_HEADER` / `CONCURRENCY_EXPOSED_HEADERS` / `etagOf` /
  `ifMatchAdmits`; `precondition_failed` carries the refused `entity` (and deliberately not
  the current version — handing it back turns the obvious client fix into a blind retry
  that overwrites whatever caused the refusal); the OpenAPI builder emits the header, the
  `ETag` and the 412 per guarded operation.
- **kernel** — `InvokeOptions` as the third argument to `ScopeStub.invoke`: the
  request-preconditions seam #116 will add `Idempotency-Key` to, plus the reply channel the
  mount reads the tag from. `assertIfMatch`. `ModuleRegistration.operationConcurrency`.
- **adapter-sqlite / adapter-cloudflare** — the comparison, inside the transaction, in the
  order above; the acknowledgement across the DO hop.
- **contract-tests** — `concurrencyContractSuite`, 13 cases both adapters pass.
- **vertical-host** — the mount reads `If-Match` on unsafe methods only (on a `GET` the
  header means a conditional read, and forwarding it would refuse a read for being stale)
  and sets `ETag`.
- **model-emit** — a guarded method routes through a `guarded()` runtime that keys tags by
  `entityType:id`, evicts on a 412 rather than replacing (auto-retrying with the new tag
  would overwrite the change that caused the refusal), and exposes the map as
  `client.versions`. A client with no guarded operation is byte-identical to before.

### Callout adopts it, and adopting it found a bug

`callout/update-facility` is the fleet's first guarded operation, with
`callout/get-facility` beside it as the read that hands out the tag — without one, the
guard is unreachable, since a client could only acquire a tag by writing.

`callout/create-facility` had never emitted an event. Nothing caught it, because "every
mutation emits a fat event" is enforced by review rather than by `boundary-lint`. The
consequence only became visible here: a facility created by a silent write has no version
at all, so every conditional update against it is refused forever, against a tag the caller
was never given. It emits `callout.facility-created` now.

Callout's conformance receipt goes from 1 narrowed check to 3, all driven.
