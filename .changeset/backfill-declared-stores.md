---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Declaring a per-tenant store now gives it to the tenants that already exist (#825).

`runtimeNeeds.tenantStores` (D1) and `runtimeNeeds.blobStores` (R2) were minted only in the
tenant-creation lifecycle — a gate every installed tenant passed long before the declaration
was written, and never passes again. So declaring a store in version N+1 gave it to *nobody*:
not at promote, not at version-binding, not at `substrat scope provision`. Adoption was an ops
step someone had to remember, per tenant, for a need the code had already started depending on.
It was found the way that always ends: contract signing in a live CRM renders the avtal PDF and
uploads it *before* the operation that freezes it, so `host.attachments()` refusing meant no
contract could be sent for signature at all — fail-closed, correct, and unfixable from the
vertical.

**Promote reconciles the fleet.** After the in-place serve (and only after — until then the
serving pointer still names the old version, so the declaration read would be the previous one),
a promote diffs each declared need against the ledgers for every tenant holding a servable
install, mints what is missing, and attaches the bindings in one ledger-derived PATCH rather
than one per tenant. Both ledgers are read once and diffed in memory, so the common case —
nothing newly declared — costs two reads and mints nothing, and re-promoting is silent.
Declaring a store is now push-and-it-works.

It is deliberately not part of the serve's success: a minting failure must not fail a promote
whose code is already live and serving. It lands an ops-failure row, rides back in the promote
response (`substrat promote` prints each mint, and warns loudly on a failure), and leaves the
per-scope retry in place.

**`substrat scope provision` is that retry.** It now mints and binds what the serving version
declares before reconciling, and carries a freshly minted `tenantStores` handle into the
reconcile so the vertical migrates it inside the usual K-31 ready-gate — a bound but unmigrated
database fails as loudly as an absent one.

**And the gap is visible while it lasts.** The real defect was never the missing mint but the
silence: `/scopes/:id/health` reported green on a scope whose next upload was guaranteed to
throw. It now compares DECLARED (the serving version's manifest) against MINTED (the ledger) and
returns `missingStores`, which the console's scope detail and `substrat scope status` render
with the lever that fixes it.
