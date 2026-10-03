---
'@substrat-run/kernel': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
---

A preview push or `scope bind` that moves a scope's data into another version's deployment no longer leaves a copy behind (#1722). Once the bind lands, the copy in the old deployment is wiped: emptied to a `carried_away` marker rather than reaped, so a later bind back to that version can carry the data in again. The bind expects the version the data was copied from, so of two pushes that read the same binding only one lands. The other is refused with a 412, and its copy is discarded unless the preview is now served from that same deployment (a CI retry of the same version). A carry also refuses an export from a scope that was re-pointed meanwhile, or from a store that was already wiped, before it restores anything. The three bind tails (preview push, `scope bind`, serving-pin repair) are now one.

A deployment built with this release also fences the wipe. A scope DO keeps a load stamp in `_substrat_meta` that never leaves in a dump. A carry's export (`/internal/export?stamp=1`) hands it over in the `x-substrat-load-stamp` header, read in the same call as the dump, and stamps a store that has none. Every other export only reads. Every load replaces the stamp, with the stamp a carry names in `/internal/restore`'s new `loadStamp` field, or with none. The new `/internal/wipe-carried` route (`wipeCarriedLocal` on the host, optional in `VerticalScopeHost`) wipes only if the stamp is still the one the carry read, so a rollback that restores into the old deployment while the cleanup is in flight keeps its data. An older deployment answers 404 there, and the wipe falls back to an unconditional load of the marker through `/internal/restore`. That path is guarded by a route re-read and by the rollback checking its own store for the marker.
