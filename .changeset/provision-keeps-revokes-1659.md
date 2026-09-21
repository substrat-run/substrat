---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
---

A reconcile no longer undoes a revoke. Re-running provisioning creates the grants it finds
missing and leaves a revoked one revoked.

Provisioning re-runs often. A private vertical's push, the console's **Re-run provisioning**,
a tenant's Update and, since the last release, every listed promote each reconcile the
installs. Each reconcile re-wrote the tuples provisioning grants with
`INSERT OR REPLACE … revoked_at = NULL`. That created a missing grant, but it also brought
back a revoked one. So a revoke of the owner's seat, of a connection grant, or of a module's
`system:<module>` schedule grant (the per-scope switch that turns its schedules off) lasted
only until the next reconcile, and nothing said so.

Provisioning now **seats** a tuple instead, with the kernel's new `SEAT_SCOPE_TUPLE_SQL`. Both
adapters use it: `provisionScopeLocal` on Cloudflare, and `provisionScope` on both.

- **Missing** → created, live. A scope whose storage was recreated is still repaired (#332).
- **Live** → its expiry follows the platform's, as before.
- **Revoked** → left exactly as it is, including `revoked_at` and `expires_at`.

**One exception, for the owner's seat.** If leaving the owner-of-record revoked would leave
the scope with no live role grant at all, a reconcile re-seats the owner. A scope nobody can
act in is the lockout a reconcile exists to repair. So revoke the owner **after** seating a
successor, and the revoke holds. Two consequences of this rule:

- Revoking the last role holder is undone at the next reconcile.
- The owner it re-seats is the one `owner_of_record` names, and the first owner written there
  stays. If a successor is later revoked too, the original owner comes back.

To lock out a compromised owner, suspend the scope. A seat revoke is not that lever.

An explicit grant still clears a revoke: `assignScopeRole`, `grantEntityLocal`,
`connectorGrantLocal`, and `HostAdmin`'s `assignRole`, `grant`, `grantToSystem`,
`grantToConnection` and `grantToOrg`. Granting someone again gives them access again.
