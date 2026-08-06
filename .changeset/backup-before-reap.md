---
"@substrat-run/control-plane-api": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
---

feat(lifecycle): a reap leaves a recoverable copy behind (#493)

`reapScope` is the one lifecycle step with no undo — it frees a scope's Durable Object
storage, which Cloudflare never garbage-collects on its own — and the copy that made it
survivable was the operator's job to remember, from a different surface. It is now a
property of the route: `POST …/scopes/:s/reap` writes a **full-fidelity dump** to a
platform-held backup store *before any byte is wiped*, and records its address on the
reap's admin-log entry. A store that throws aborts the reap with the scope intact,
answered as a `502` that says the data is untouched rather than a bare 500.

A **dump, not a snapshot fork**, deliberately: `orchestratedSnapshot` provisions the fork
inside the vertical's own deployment and activates it, so a fork's bytes live in the very
deployment a retirement is about to delete, and it counts as a live scope in
`countScopesForVertical` — re-blocking the `deleteVertical` the reap was clearing. A dump
leaves the deployment, and `POST …/restore` already loads one back.

Full fidelity, never masked. `GET …/export` masks by default because it hands bytes to a
*caller*; a backup goes platform→platform and is never handed out, and a masked dump
restores a structurally-valid but factually wrong scope.

New seam `ScopeBackupStore` (host-injected, provider-neutral like `ObservabilityReader`)
with `createR2BackupStore` for Cloudflare R2, plus `GET/POST …/scopes/:s/backups` and
`GET …/scopes/:s/backups/:capturedAt`. `reapScope`'s options gain `backupRef`, carried
into the audit entry (`after.backupRef`, explicitly `null` when no copy was taken).
`ScopeBackup` joins `scopeDump` in contracts.

Defaults are per-act, not global: a **scope** reap backs up unless told otherwise, while a
**tenant** reap (§4.8, partly an Art. 17 erasure path) takes no copy unless staff ask —
silently writing an erased customer's data to a bucket would defeat the request. Asking
for a backup where no store is configured is refused `501`, never silently skipped, so a
control plane deployed with the bucket unbound fails loudly; a caller that does not ask
still reaps unbacked where no store exists (self-host, embedded). Jurisdiction-pinned
scopes are refused until a per-jurisdiction store exists (K-32) — the reap must not wipe
what the platform may not legally copy.
