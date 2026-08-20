---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/connector-scrive': minor
'@substrat-run/dashboard': minor
'@substrat-run/control-plane': minor
---

A connection's grants become readable, and a connector's per-dispatch read stops being a standing one.

Every other authority in this model is inspectable from where a vertical sits: the permission
surface is diffed at promote, role tuples are readable from the scope, entitlements and identity
links are projected and read back locally. A connection's grants were the exception — write-only
from the deployment, readable only with staff access to the control plane — and they are the
authority behind the one actor that is not a person.

That blind spot has a cost on the record. `protocol:attach` was missing from a live Scrive
connection for months, failing the sealed-copy landing into a `skipped` reason nobody reads, on
a path whose whole purpose is to bring a legal signature home. It was found by a human reading a
diff on an unrelated PR (#716). There was no read that could have surfaced it and no alarm that
would have.

## The read

`ScopeHost.connectionGrantsInScope(tenantId, scopeId)` answers from the scope's **own delivered
tuples** — the rows the permission checker itself walks — so what it returns is what would
actually be enforced there, including a scope whose delivery is behind the directory. The
directory's view is a different fact and stays on `HostAdmin`. `conn.grants()` narrows it to one
connection inside a dispatch, so a connector can assert its preconditions at the top of a
delivery instead of meeting a missing grant as a refusal several calls later.

Both tuple stores are read, and getting that wrong was the near-miss. A scope check consults
tenant-level tuples too (rule-2 inheritance), and the two adapters split them differently: the
pure adapter keeps tenant-wide grants in the directory, while a Cloudflare scope holds *projected*
tenant tuples in its DO and *live* ones in the control plane. Reading only the scope's own table
reports a tenant-wide grant absent while it is being enforced — a read-back that disagrees with
the checker is worse than none, because it is the read an operator would believe. The contract
suite pins the agreement against real evaluation via the probe operation, not against the rows
the query happened to select.

## The per-dispatch capability (#726 remedy B)

The check site is entity-aware and the grant site is not. `attachments.open` asks
`ctx.check(gate.read, { entityType, entityId })`; `connectionGrant.node` is `{ tenantId, scopeId }`
with no entity leg, so a connection could only ever hold a permission scope-wide. The narrow
question was being answered by the one model that could not answer it narrowly.

And the read a signing connector makes is per-dispatch by nature. The event names one
`documentAttachmentId`; `bindDocument` already refuses to bind an attachment owned by anything
but the instance being signed; `openAttachment` takes an id rather than a search. So the
authority becomes the delivery:

> A connector dispatch may open attachments owned by the entity the delivered event names.

Nothing new had to be invented to carry it — both facts were already kernel-stamped, and both
adapters already tracked the delivery as ambient dispatch state (`causedBy`). The entity is
**derived, never asserted by the caller**: what crosses the hosted `/internal` seam is an event
id the serving deployment resolves against its own outbox. The platform runs the connector and
can name any delivery; it cannot name an entity.

There is no fallback to the permission check, on either a mismatch or an unresolvable id.
"We could not resolve the delivery, so check the grant instead" is how a narrowing becomes a
no-op — and a grant would re-widen exactly what this narrows, since `protocol:read` is not a
keyhole: it also gates `protocol/get`, `list-templates` and `list-for-entity`, none of which a
connector sending one named document reaches.

`protocol:read` accordingly leaves the dashboard's Scrive catalog. There is no grant to hold, so
there is none to miss.

## The declaration, and the gate that makes it load-bearing

Three lists described one fact and nothing checked that they agreed: the connector declared what
it needed in prose, the dashboard's catalog hardcoded what it would grant, and a vertical passed
a third list with its own upsert. They did disagree — the catalog still read
`['protocol:record-signature', 'protocol:attach']` after connector-scrive 0.9.0 shipped needing
more, so no tenant connecting through the dashboard could be granted what the connector
required, and that surfaced as an avtal failing to reach Scrive (#841).

`SCRIVE_CONNECTION_GRANTS` puts the requirement where the knowledge is. `pnpm
lint:connector-grants` (new CI step) fails when no dashboard door can carry one. Standing grants
only, deliberately: per-dispatch reads are authorized by the delivery now, so they belong in
neither list; what remains is the return path, which runs top-level with no delivered event
behind it. It checks a floor rather than an equality, so tightening a connector's needs never
reds the repo on a stale extra.

## What did NOT get built, and why

## Updating a permission on an existing connection

A connection's grants could only ever be written alongside a credential: both writing doors
write the secret and then loop `grants`, so the remedy for "a capability is missing" was "re-type
your Scrive credential" — on a rotation path that, done wrong, replaces a working one. The #592
reconcile did not help, because it gathers grants that ALREADY exist as directory rows and
delivers them to scopes; it repairs a dropped *delivery*, never a grant that was never made.

Every reconcile now heals toward the connector's declaration before gathering. A declared key the
connection lacks is granted tenant-wide — so it reaches installs that do not exist yet — and the
operator's existing lever, the idempotent re-provision, is what applies it. A connector that
declares a new grant delivers it on the next reconcile.

**This is not the grant-only button that was declined**, and the difference is what makes it
legitimate. A button would let a person add an arbitrary permission from a console: an authority
decision, taken by someone, with no tenant principal behind it — precisely the laundering
§3.5.1 forbids. This decides nothing; it materializes a requirement declared in code, the way a
module's declared schedules are projected as `system:<moduleId>` grants. No one chose it, so
there is no act to attribute.

**A floor, never a ceiling.** Declared keys are granted; nothing is ever revoked, because a
connection may legitimately hold more than its connector declares and a pruning reconcile would
revoke authority nobody asked it to touch — on every tenant at once, the day a declaration
shrinks. The trade that buys: a key that stops being declared is not cleaned up, so
`protocol:read` stays on connections already granted it. Harmless, visible in the read-back, and
deliberate.

## Three tests changed behaviour rather than breaking

That change is the substance, so each was rewritten to pin the new rule from both sides rather
than deleted:

- The connector sends the bound document **holding no read grant at all** — and refuses an
  attachment the delivery does not name **while holding the key**.
- The invariant those tests were really protecting — send NOTHING rather than the wrong paper —
  moves onto the failure that can still happen: a binding whose bytes are gone still
  dead-letters rather than substituting the attestation sheet.
- The `/internal` seam test now asserts the delivery is carried through, because a dropped
  `eventId` would silently fall back to the grant check — which looks like it works, right up
  until the grant is the one that was removed.
