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

A scope rebind's migration acknowledgement now answers one review, as a promote's does. `GET /tenants/:tenantId/scopes/:scopeId/rebind-review?vertical=<target>` returns what the rebind would apply: the target vertical's serving version over the version the scope is bound to, each migration with its SQL and declared moves and discards. Beside it is a `review` binding: the scope's bound version, and a digest of both sides' stored rows that is taken under its own tag, so a promote's binding is never accepted as a rebind's, or the reverse. `POST …/rebind-vertical` takes it as `acknowledge.review`. The control plane recomputes the digest from its own rows and refuses with `precondition_failed`, reason `rebind_review_stale`, when the scope is no longer bound to that version or a promote on either vertical has moved what the review showed. The read follows exactly the rebind's own visibility. It is one shared rule: a workspace credential needs to be able to read both verticals (its own, or a listed one), and everything else answers the same 404, for the read and for the rebind.

A rebind now moves the scope's route and its version pointer in one write. That write is conditional on the scope still being bound to the judged version and on the target still serving the judged version, on both adapters (`bindScopeVersion` gains the additive options `servingRef` and `expectedServing`). Before, these were two writes, and a promote on the target landing between them left the route on the new script and the pointer on the old vertical. A promote that lands while the data is being copied now refuses the rebind as stale; the scope keeps serving from where it was, and both copies are kept.

**Behaviour change:** an `ackMigrations` without a binding is refused when the two migration digests differ (`precondition_failed`, reason `rebind_review_unbound`). The refusal says to upgrade to a CLI release whose `substrat scope rebind` supports `--review`, which this one does. `substrat scope rebind` prints the migrations and a `--review <token>` with every digest, stale or unbound refusal, and takes it back with `--review`. The dashboard's and the console's Move dialogs now read the review before they ask and show the migrations. They send each install's binding, and when a version changes under them they read the review again and ask again from scratch.
