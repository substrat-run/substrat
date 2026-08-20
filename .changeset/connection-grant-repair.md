---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
---

Updating a permission on an existing connection no longer means re-typing a working credential.

The entry above this one closed three quarters of #726 and said plainly that this quarter was
not built. This is that quarter.

A connection's grants could only ever be written **alongside a credential**. Both writing doors —
the dashboard's connect flow and the tenant relay — write the secret and then loop `grants`, so
the remedy for "a capability is missing" was "re-submit your Scrive credential", on a rotation
path that, done wrong, replaces a working one. And the #592 reconcile did not help, though it
looked like it should: it gathers grants that **already exist** as directory rows and delivers
them to scopes. It repairs a dropped *delivery*; it never creates a grant that was never made.

So `protocol:attach` sat missing on a live connection for months (#716) with no proportionate way
to add it — and once the read-back landed, the situation was that an operator could finally *see*
the problem and still had only the disproportionate repair.

## Heal first, gather second

`reconcileConnectionGrants` runs before the gather on both the reconcile route and
provision-instance, so no path can forget it. A key the connector declares and the connection
does not hold is granted **tenant-wide** — materialized per scope by the existing #592 machinery,
so it reaches installs that do not exist yet — and the lever that applies it is the one operators
already reach for, the idempotent re-provision. A connector that declares a new grant delivers it
on the next reconcile.

Best-effort by contract: healing reaches the directory, and a failure there must never take down
the reconcile it rides on. A bad pass leaves exactly the behaviour that shipped before it existed.

## Why this is not the button that was declined

The distinction is the whole reason this one is legitimate, so it is worth stating rather than
assuming.

A grant-only write route would let a person add an arbitrary permission to a connection from a
console: an authority decision, taken by someone, with no tenant principal behind it — precisely
the laundering `connections.md` §3.5.1 forbids.

This decides nothing. It materializes a requirement the **connector declared in code**, exactly
as a module's declared schedules are projected as `system:<moduleId>` grants at provisioning. No
one chose it, so there is no act to attribute, and the platform actor on `grantedBy` is honest
rather than a stand-in for a person. What a connection may do still follows from a declaration
that lands in a diff — it simply no longer needs a credential to deliver.

## A floor, never a ceiling

Declared keys are granted; nothing is ever revoked. A connection may legitimately hold more than
its connector declares — a second connector on the same provider, a key granted for a path not
modelled here — and a reconcile that pruned to the declaration would revoke authority nobody
asked it to touch, on every tenant at once the day a declaration shrinks. `lint:connector-grants`
checks that same floor against the dashboard's catalog, so the two cannot drift apart in the
direction that matters.

The trade that buys, stated rather than hidden: a key that stops being declared is not cleaned
up. `protocol:read` — needed by nothing since the per-dispatch capability — stays on connections
already granted it. Harmless, visible in the read-back, and deliberate.

## Verified against a real host, not a mock directory

The load-bearing assertion is that the healed grant is **enforced**, so it is made through the
scope's own read-back rather than the directory's list: a row nobody delivers is the #592 failure
mode in reverse, and asserting on the list would have passed for it. Around that: the grant
reaches a later install, a second pass changes nothing, a key the declaration does not name
survives, a working scope-targeted grant is not shadowed by a tenant-wide twin, nothing outside
the declaration's (tenant, vertical, provider) is touched, and a host that declares no connectors
behaves exactly as before. The route-level test drives the whole path and checks the credential
comes out untouched.
