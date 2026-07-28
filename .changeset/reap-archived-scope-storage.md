---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
'@substrat-run/console': minor
---

Reap archived scopes (§4.4): free the Durable Object storage that Cloudflare never
garbage-collects. Deleting an app archives its scope — a tombstone-only transition that
keeps the directory row but leaves the scope DO holding every byte forever. This adds a
terminal `reaped` state past `archived`: `reapScope` wipes the DO's storage while keeping
the directory row (audit history + burned slug), the one irreversible scope transition, so
it only ever leaves `archived`, `getScope` fails closed on it, and its slug is released for
reuse. Delivered two ways over one seam — the storage wipe reaches the vertical's own
deployment (a hosted scope's DO is CP-less) via the same `deleteScope` dispatch the snapshot
GC uses: a staff-only `POST /tenants/:t/scopes/:s/reap` (armed in the console behind a
type-the-slug dialog, since there is no restore), and a `runPlatformSweep` phase that reaps
scopes archived longer than `SCOPE_RETENTION_DAYS` — opt-in and unset by default, because
the reap cannot be undone. Both adapters gain an additive `archived_at` column (stamped on
archive, cleared on unarchive) to age the sweep, and their `(tenant_id, slug)` unique index
becomes partial on the live statuses so a retained tombstone never blocks the slug reuse the
pre-check already intends — closing a latent gap where archived slugs could not actually be
reclaimed.
