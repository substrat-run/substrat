---
'@substrat-run/kernel': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contracts': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

A preview push or `scope bind` that moves a scope's data into another version's deployment now wipes the copy it leaves behind (#1722). Once the bind lands, the old copy is emptied to a `carried_away` marker rather than reaped, so a later bind back to that version can carry the data in again. The three bind tails (preview push, `scope bind`, serving-pin repair) are now one.

**Only one of two racing carries binds.** The bind expects the version the data was copied from, so of two pushes that read the same binding only one lands. The other is refused with a 412, and its copy is discarded, unless the preview is now served from that same deployment (a CI retry of the same version). A carry also refuses, before restoring anything, an export from a scope that was re-pointed meanwhile, or from a store that was already wiped. Right before it binds, a carry reads its source again. If anything changed there since the export (a write, a load, or a clear of its copy marker), it carries again from a fresh export. After three tries it is refused with a typed 409 (`carrySourceChanged`), with nothing bound.

**Every act on a store is fenced on that store.** A scope DO keeps a load stamp and a write revision in `_substrat_meta`, and neither ever leaves in a dump. Every load replaces the stamp. Every write advances the revision inside the transaction that commits it, an in-place update such as a drain receipt included.
- A carry's export (`/internal/export?stamp=1`) hands both over, in the `x-substrat-load-stamp` and `x-substrat-write-revision` headers, read in the same call as the dump.
- A carry reads the destination's marker (`/internal/load-marker`) and sends it back as `expect` on `/internal/restore`, so a retried push never overwrites a store another run bound and wrote to.
- The source wipe (`/internal/wipe-carried`) runs only if the source still holds what the carry exported, so a rollback that restored there meanwhile keeps its data.
- Every comparison happens inside the act's own transaction, and a refusal answers 412.

**A copy that took a write the carry did not copy is kept, not wiped.** It is recorded as `source-copy-kept` and protected in its own store: every load into it, a bind back included, is refused (409) until staff resolve it through the staff-only `GET /tenants/:t/scopes/:s/kept-copy` and `POST …/kept-copy/resolve`. The resolutions are:
- `discard`;
- `restore-forward` over the live store, acknowledging the live writes it replaces. It is fenced on the binding throughout, and discards the kept copy only once its data is where the scope still routes;
- `release`, for a kept copy that turned out to be the live store.

`GET …/kept-copy/export` pulls the kept copy under the governed export's rules (residency, masking unless `full=true`, access-logged) for reconciling by hand. Each resolution is fenced on the kept copy's load stamp and revision, and logged through the new `HostAdmin.recordKeptCopyResolution` (admin action `resolveKeptCopy`). A copy the carry wiped refuses writes, so a stale request still routed to it lands nothing.

**Copy marking (#2005).** A copy the carry wipes or keeps stays marked a copy whenever the directory says the scope is not primary, including a copy made before the marker existed. Marking a store a copy never counts as a write the carry missed. Clearing a mistaken marker does count. If a staff clear lands after the carry's last check of its source, the source records it, and the platform brings the clear to the store the scope now runs on: it clears that store's marker, fenced on this carry's own load of it and its revision (`/internal/clear-copy-mark` takes `expect`), and only then discards the source. A store another load has replaced meanwhile keeps its marker.

**Older deployments.** A deployment built before this release answers 404 on the new routes. Only a 404, a 501, or an HTML shell served as `text/html` reads as an older deployment. A lost, truncated or malformed answer is a failure, never a fallback. There, the wipe falls back to an unconditional load of the tombstone through `/internal/restore`, guarded by a route re-read and by the rollback checking its own store. The restore is guarded only by the binding read right before it. **Re-push every vertical after this release** so its scripts carry the fenced paths. The two remaining old-script windows close as each vertical is re-pushed.

The cleanup is best effort: a carry that fails between its restore and its wipe can still leave a copy, and reconciling those is not done yet.
