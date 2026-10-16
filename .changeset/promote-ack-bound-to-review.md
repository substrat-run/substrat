---
"@substrat-run/contracts": patch
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/control-plane-client": patch
"@substrat-run/cli": patch
"@substrat-run/dashboard": patch
"@substrat-run/dashboard-web": patch
"@substrat-run/console": patch
"@substrat-run/docs": patch
---

A promote acknowledgement now answers one review. The review a promote shows is computed against the version prod points at when it is read, and a promote by someone else in between used to leave the acknowledgement standing for a diff that was no longer the one applied. The migrations read (`/versions/:id/migrations?base=`) now answers a `review` binding beside the diff it shows: the base version and a digest of the stored rows the review was computed from (each side's id, permission and migration digests, and every stored migration with its declared moves and discards). A promote carries it as `acknowledge.review`, and the control plane recomputes the digest from its own rows and refuses, as `precondition_failed` with reason `promote_review_stale`, when prod no longer points at that base or the digest differs. The sent digest is only compared, never read as the diff.

**Behaviour change:** a migration acknowledgement without a binding is refused when the migration digest moved (`precondition_failed`, reason `promote_review_unbound`), because it is the acknowledgement that lets a migration, and any data loss it declares, reach live data. An older `substrat promote --ack-migrations` is refused that way, and the refusal names the CLI release that sends the binding. A permission-only acknowledgement without one is still honoured, so an older client keeps promoting where no migration changes; a binding, when sent, covers the permission diff too.

`substrat promote` prints a `--review <token>` with every refusal that prints the diffs, and takes it back with `--review`; a stale or unbound refusal prints the diffs as they stand now, with the new token. The dashboard's promote dialog sends the binding with every promote, and when prod moved it reads the review again and asks again from scratch, saying so, with nothing ticked carried over. The console's promote dialog binds its acknowledgement to the review it read and, refused as stale, reloads the channel and shows the new review. The refusal's header line in `substrat promote` now quotes a version id that is not a plain id, as the migration listing already did.
