---
id: D-71
date: 2026-11-07
layer: plan
title: "A store object a deletion has fenced refuses what that deletion left in flight"
status: proposed
aliases: []
amends: ["D-63", "D-69", "K-50", "K-52"]
tracking: ["#2285"]
---

# D-71 — A store object a deletion has fenced refuses what that deletion left in flight

> **Proposed 2026-11-07, not ratified.** This closes the item the scope-stores page lists before the
> first approval of a driver release in production. It is written so that the choice can be made, and the
> code in this change follows it. Three choices are the maintainer's, and they are named at the end.

**Every path that deletes a scope's stores now sends `substrat.fence`, not `substrat.wipe`. The store
entry answers it: it writes a tombstone in the object, waits out the calls inside the driver, hands the
driver a plain `substrat.wipe`, and writes the tombstone again. From then on the object refuses every
call of audience `caller`, whenever it was signed, and every platform call that would write
(`stage-page`, `commit-stage`). The tombstone is never cleared. Where the scope's row outlives the fence,
the directory says so first (`stores_fenced_at`), and the scope then cannot be unarchived or restored
into, nor its tenant un-deleted. No driver changes, no router changes, and no directory read is added to a
store call.**

## Why

`unrouteScope` ends new requests by unbinding hostnames, and only that. Three things outlive it:

- a request already running, which holds its dispatch's store list and may still call;
- a call the router has signed and that is still on its way, since an envelope is fresh for
  `SCOPE_STORE_ENVELOPE_WINDOW_SECONDS` (60 s). The nonce (K-59) admits it once, and it has not been
  admitted yet;
- a call inside the driver when the wipe arrives, because a Durable Object's input gate opens while a
  driver awaits a subrequest.

Any of these writing after the wipe recreates the object. The graph driver's own comment says so:
"The next vertical call creates the repository." Nothing left could reach that object. A scope that is
archived, or whose tenant is deleting, is no longer served, since the route read wants an active scope of
an active tenant, but that stops new requests just as an unroute does. And since D-69, a restore run in one
request into an archived scope could commit between a reap's wipe and its status flip.

## The options

| Option | Closes signed-then-delivered? | Cost |
| --- | --- | --- |
| A directory state, read when the router signs | No. A call signed just before the state is set still lands | A read of the coordinator on every store call, where today a store call reads nothing |
| That state, then wait out the 60 s window before the wipe | Yes, for the clock skew assumed | Every reap route spends a minute or more, in a request that also holds a backup. A running request can still hold a store list, so it only closes with the read above |
| An epoch in the envelope, which the object compares | Yes | A new envelope version, a new line for every verifier, and an object that stores an epoch anyway |
| A tombstone in the object, written by the platform's own deletion | Yes, at the point where a write would land | One storage read per object instance, and one small row per deleted store |

The fourth is the smallest that closes it, and it is the shape this platform already chose for a scope:
`destroyStorage` writes `_substrat_reaped` after `deleteAll()`, "a permanent fence rather than a lock:
any later write to this DO is refused whenever it arrives, without coordinating with the lifecycle that
killed it". A store now has the same.

**Why no check at signing.** The first idea put the check where the router signs. It is not
needed, because the check made inside the object is later than any signature. It would also cost a
coordinator read per store call for a refusal that would otherwise come one hop further on. It is
additive, so it can be added if it is ever wanted as a faster refusal. It is not part of the fence.

## The design

**The fence is the entry's** (`store-entry/fence.ts`, run by both entries, the Python one through the
verifier module). `substrat.fence` is admitted for audience `platform` only (K-52's closed table). It is
not in `RESERVED_STORE_OPERATIONS`, since a driver never answers it, and the canary does not call it.

**One call, so a retry runs all of it.** The steps on the object are:

1. Set the mark in memory and write it to storage. Anything arriving now is refused.
2. Wait for the calls already inside the driver, up to 30 s. Past that it answers 503
   (`store_fence_draining`), the mark stays, and the reap stops there, retryable: its next try sends the
   whole fence again.
3. Hand the driver `substrat.wipe`. A driver's wipe may `deleteAll()`, as the graph driver's does, which
   takes the mark too.
4. Write the mark again, in a `finally`. The answer goes only after that.

A call counts as inside until its `fetch` has returned. **Work a driver leaves running after that is
not waited for** (below).

A crash in step 3 or 4 loses the mark with the answer. Calls that land in that gap are real writes, but
the answer was lost, so the platform asks again and the next run wipes them before it answers. The test
`a crash between the wipe and the second mark` shows it.

**Who it stops, and who it does not.** A `caller` call of any operation is refused with 410
(`store_fenced`), in the store envelope. A vertical reads it as `not_found` with `storeCode: store_fenced`.
The catalog has no `gone`, and `unavailable`, which any status without a row becomes, reads as worth
retrying, where this refusal is for good. The entry's other refusals are plain text, outside the envelope
(#2815). These two, the 410 and a fence's 503, are not, since they say what the store object is, gone or
draining, and a vertical has to tell a store gone for good from a bad answer. A driver could answer the
same code, and a vertical would learn nothing it could use from that. A platform `stage-page` or
`commit-stage` is refused the same way. The platform's reads, an erase, a discard, a plain wipe and a
fence asked again still pass, since none can put a row back. Once the object is fenced, a platform call that passes writes the mark again when it ends, whatever its
driver did. An alarm does not reach the driver of a fenced object. An envelope's nonce (K-59) is spent
before the fence is asked, so a refused call spends it too. A driver's wipe that clears the object's
storage forgets the nonces with it, and an envelope replayed after that still meets the mark.

**A plain `substrat.wipe` fences nothing.** The canary and the contract use it, and a store written
after it behaves as before. A wipe is an operation on a store. A fence is a statement about its scope.

**Which store objects.** The stores are read twice: once before anything is destroyed, so a store that
cannot be named refuses with the scope whole (#2285), and again once the scope is no longer served, for
the fence. That second read is what makes the fence reach every object a running request could still name. Only a request
routed by hostname carries a store list: a peer dispatch carries none, and a call from a Durable Object
has no way out (RFC §10.8 (t) and (u)). A version's bindings are recorded with its row in one transaction.
So any binding a request routed before that point can name was recorded before the second read. Without
that read, a version published between the first read and the unroute could name a binding nobody fences.

The second read has a price. It runs after the unroute, so a read that fails there (503: a store that
cannot be named, a record that cannot be read) leaves a snapshot or a preview unrouted and not deleted.
Nothing is fenced and nothing is lost, and the reap is retryable: asked again, it finds no name to unbind
and reads again.

## Every deletion path

| Path | Before | Now |
| --- | --- | --- |
| Scope reap route | Archived, unroute, wipe, delete | Archived, unroute, fence, delete. The route refuses a scope that still has a hostname, so the unroute finds none |
| Snapshot DELETE | Unroute, wipe, delete | Unroute, fence, delete |
| Preview reap | Unroute, wipe, delete | Unroute, fence, delete |
| Sweep's snapshot reap | Unroute, wipe, delete | Unroute, fence, delete |
| Tenant reap route | Archived, wipe, delete, release names | Archived, fence, delete, release names |
| Retention sweep, and the tenant sweep through it | Archived, wipe, then the claim, then delete | Archived, claim, fence, delete (`reapRetainedScope`). The claim moves first, since a fence cannot be undone and a copy move in flight refuses it. The tenant sweep reaps each scope through the sweep's `reapTenantScopeFn`, which holds the tenant to `deleting` |
| A fork that failed its snapshot | Left for the sweep, which reaps it as a snapshot | The same, so the sweep's reap fences it |

A restore has no wipe of its own: only its commit replaces the object.

**The directory says so first.** On the three paths that keep the row (scope reap, tenant reap,
retention), `HostAdmin.markScopeStoresFenced` writes `stores_fenced_at` immediately before the first fence,
and only when there is a store to fence. It is a column on the scope, kept through a directory dump and its
restore, and never cleared. Its own fact, and not `reap_claimed_at`: a claim is taken before a store read
that can refuse, so it would hold a whole scope for good, and the tenant reap takes none.

- The mark and an unarchive are one step each on the directory, and the mark wants the scope archived. So
  an unarchive that gets in first wins: the mark refuses with `conflict`, no store is fenced, and the scope
  is live. An unarchive after the mark refuses. Neither order leaves an active scope with refusing stores.
- A tenant cannot leave `deleting` while a scope of it is marked and not yet reaped. On a tenant reap the
  mark also wants the tenant still `deleting`, so an un-delete that gets in first stops the reap there.
- Both restore routes refuse a marked scope (409) before any load or stage. The refusal names the way out,
  in every case: finish the reap. Its data is in the backup the reap took, which reaches a new scope only
  when it is small enough to download whole (below).

**The price is a refusal that can be more than it needs to be.** The mark goes down before the fence, so a
fence that never lands (an unreachable script, a reap given up) leaves a whole scope that will not come back.
Refusing is the safe default: the mark cannot tell how far the fences got, and a scope that came back with
one store refusing for good is the worse failure. A marked scope's stores are not read for a copy either: a
backup, a fork and a full pull or tenant export of it refuse (409) with the same way out, since a fenced
store answers a read with what the wipe left, and the copy would look whole. A reap asked again on a scope
an earlier try of it marked takes no new backup: the scope reap refuses one, names the backup the earlier
try took, and finishes with `backup=false`, and the tenant reap skips that scope's backup and backs up the
rest. So the copy a reap takes before its mark is the one that holds the data. A full tenant export
(`?full=true`) reads every scope's stores, so a reap stuck on an unreachable script blocks it until the reap
finishes. The masked export reads no store and is unaffected.

**The way out reaches only a small backup.** The refusals name a new scope, with new objects. A backup
stored in one entry, with each store in one page, downloads whole (`GET …/backups/:capturedAt`) and restores
into another scope through `POST …/scopes/<new>/restore`. A larger one restores only through
`POST …/scopes/:scopeId/backups/:capturedAt/restore`, which reads it under its own scope (D-69), and that
scope is reaped or fenced. So a backup stored in several entries or pages cannot be restored anywhere yet. A
restore into another scope closes this, and it is not built here.

**A restore or a snapshot still works.** A restore landing in another scope, as a reaped scope's backup
must, has new objects and is unaffected. So is a snapshot, whose fork has a fresh ULID, and so is a carry or
a rebind: a store is per scope and not per script, and they fence nothing.

**A scope id can be chosen, and that is the one way into a fenced object from a new row.** A reaped row
stays, so its id stays taken. A deleted snapshot or preview loses its row, and `POST /scopes` takes a
client-chosen id, so re-posting that exact id gives a new scope over the old objects, whose stores refuse
for good. No row is left to say so, and recording every deleted fork's id for this one case is not worth it.
It fails loudly, with `store_fenced` on the first store call, and it holds no data. It is stated here and not
closed.

## A restore a reap overtakes

A restore runs in one request, and checks the mark once, when it begins. A reap of an archived scope can
mark and fence it while the restore runs, and that is closed at the object: a commit before the fence is
wiped by it, one inside the driver is waited out and then wiped, and one after is refused with 410.

A restore already past its route's check when the mark lands fails in the order D-69 gives it. It stages
every store first, so a fence before that ends is met at the next `stage-page`, before any load. Past that
it loads the scope's own tables and then commits, so a fence there is met at the commit, with those tables
loaded, and the restore answers the commit's 410, naming what it committed. The reap deletes the tables
with the rest of the scope.

## What a driver can reach

**The mark is in the object's own storage, and a driver can delete it.** The driver runs with the
object's `ctx`, as `entry.ts` says. The key `_substrat_store_fence` is the entry's by convention, kept
from a careless driver and not from a hostile one:

- A driver's `deleteAll()` in its wipe is expected and handled (step 4).
- A driver's `deleteAll()` or `delete` anywhere else holds only until the instance is evicted, since the
  instance holds the mark in memory and every platform call on a fenced object writes it back.
- A driver written to remove it succeeds. So does one that ignores the whole entry. That is what the
  review of a release is for (D-63, D-67), and what isolation does not yet give (#2830). D-70 proposes
  that verification and the nonce move into a supervisor that runs no driver code, with the driver's class
  in a facet whose storage is its own. The mark moves there with the nonce, out of the driver's reach.
- A driver that reads its storage by listing keys would see the key, only on an object being deleted.

Live objects carry no mark at all, so a driver sees nothing new until its scope is deleted.

## A rule for a driver

**A driver does all its writing before its `fetch` returns.** The entry counts a call as inside until then.
`ctx.waitUntil`, a task nobody awaits, or a body still streaming are invisible to it, so they could write
after the wipe and recreate what it removed. This is not enforceable from the entry, so it is an item in the
review of a release, beside the others D-63 lists. An alarm a driver sets is not covered by this rule: the
entry drops alarms on a fenced object.

The graph driver complies, by reading its source, not by a run: its `fetch` awaits `scope.persist()` before
it answers, its body is a finished string, and nothing it ships uses `wait_until`. It ships tasks of its own: a
runtime may run owned tasks, one of which can outlast a cancelled call, and a wipe awaits them, as long as
that runtime is in the same instance. The isolation review of its release names this. The alarm it sets for
open work stops at the entry.

## Deploy overlap

The fence depends on the store script and the control plane, and not on the router.

| Overlap | What happens |
| --- | --- |
| Router older or newer than either | Nothing changes. The router is not consulted |
| Store script older than the control plane | This is every deploy, for a while: the control plane uploads store scripts from the entry bundled in it (`rebuildStoreScripts`), so the new control plane has to be up first, and its walk then replaces each script. Until the walk reaches a script, a reap gets 502 `bad_envelope`, since the old entry refuses `substrat.fence` in plain text, and fails closed and retryable. Snapshot and preview reaps have unbound their names by then, and scope, tenant and retention reaps have marked the scope, so such a scope will not come back even though nothing was fenced. No store is taken for fenced that was not |
| Control plane older than the store script | Only on a rollback. It sends `substrat.wipe`, with the old gap and nothing worse. A plain wipe on a fenced object keeps the mark |

No driver release is approved in production yet, so no store script holds tenant data there. It matters
from the first approval in production on: avoid reaping across a deploy that changes the entry.

## What is not closed

- **The CI probe.** Both entries ran on local workerd, the Python one under the runtime's own SDK and under
  `workers-runtime-sdk` as `uv.lock` pins it (`store-entry-python.workerd.test.ts`), since the two hand it
  different objects. The probe in `store-entry-python.yml` runs the entry under `pywrangler dev` and has to
  pass in CI. A deployed run has been made, on a real graph driver object on a test account, through a service
  binding standing in for dispatch: a call in flight finishes, a caller and a platform write then answer 410,
  the mark outlives a wipe and a redeploy, a drain past 30 s answers 503 and a retried fence succeeds.
- **A driver's work after its answer**, above. It is a review item, and nothing refuses it.
- **Durability under a real crash.** Output gates are what make the mark durable before an answer, and
  the crash test models them. An eviction on real storage is shown (`ctx.abort`). A machine failure
  between `deleteAll()` and the second write is argued, not shown.
- **A hostile driver.** Above.
- **Co-located hosts.** `adapter-sqlite` and a Cloudflare host with a direct binding wipe through their
  own lifecycle, with no entry and no envelope. They keep the plain wipe. It is the dev path, and RFC
  §10.8 already says what it owes before a driver runs off the platform hop.
- **A name bound during a reap.** On a scope that is still active, as a snapshot or a preview is, a
  hostname bound after the unroute and before the row goes routes again. The fence still refuses its calls, for every binding the second read found. Only a binding
  published in that same gap escapes, and it then needs a version published and a hostname bound inside
  one reap. Refusing a bind once the reap has been claimed would close it, and it is outside this step.
- **A large backup of a fenced scope.** It cannot be restored into another scope (above). That gap is
  D-69's: its restore route reads a backup under the scope it lands in.
- **The cost of a tombstone.** One small row in one object per deleted binding, kept until the store
  script goes. It holds nothing of the tenant's, and the object's name is not in it. A fence reaches an
  object nothing ever wrote, and creates it to hold the mark.

## For the maintainer

1. **Is a fence one way?** Yes, as built: nothing clears the mark or the tombstone, and a scope a reap has
   marked is finished or replaced. If an undo is wanted, `substrat.unfence` is one more operation in the
   entry, with a way to clear the column, and nothing here stands in its way. Whether a mark should wait until
   a first store has answered, at the cost of a window where a fenced scope can come back, is also yours.
2. **Should the fence also refuse a platform write?** Yes, as proposed: that is what stops a restore a reap
   overtakes.
   If a recovery path ever needs to write into a fenced object, it needs the undo above, explicitly.
3. **A check at signing.** Not proposed, for the reasons above. It stays available as a faster refusal.

The rule that no work runs after a driver's answer is a review item, and the approval records no field for it.
Whether it should is a fourth, smaller question.

## Revisit

This record is revisited when the driver's code moves out of the store script into an isolate of its own
(D-70), which leaves verification in the script and takes the mark out of the driver's reach, when the
Python entry's probe shows the bridge behaves differently, or if a store's tombstones become a real cost.
