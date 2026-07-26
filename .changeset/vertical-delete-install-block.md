---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/console': minor
'@substrat-run/dashboard': patch
---

Vertical lifecycle: delete a vertical, and block new installs of one.

**`deleteVertical`** (HostAdmin + `DELETE /verticals/:slug`, staff-only): removes the
registry row, its versions, and its channels — **refused while any scope is still
bound** to the vertical, naming the count, so a delete can never strand a live scope's
version pin or routing. Deployed dispatch scripts are left as orphans for the cleanup
script (#248), never reaped inline. Audited. The console's vertical detail card gets a
type-the-slug-to-confirm Delete.

**`installsBlocked`** (new registry flag + `setVerticalInstallsBlocked` /
`POST /verticals/:slug/install-block`, staff-only): the install kill-switch, orthogonal
to `listed`. A blocked vertical is hidden from the dashboard's install catalog and the
control plane refuses to provision an instance of it (403) — for everyone, owner
included. Existing scopes keep serving: it gates provisioning, not serving. Additive
`installs_blocked` column in both adapters (attempt-and-tolerate migration, default 0).
Console gets a Block/Allow installs toggle and a "blocked" badge.

The console also now shows **timestamps**: when each version was pushed (table +
promote picker), when each channel pointer last moved, and when a vertical was
registered.
