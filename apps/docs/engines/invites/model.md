# Invites: domain model & invariants

## The state machine

<StateMachine engine="invites" />

Terminal states are terminal. An accepted invitation cannot be revoked, a revoked one
cannot be accepted, and an expired one cannot be revived — a new invitation is a new
row.

## One table

```sql
invites_invitation (
  id, org_id, identifier_hash, role_key, state,
  invited_by, accepted_by, created_at, expires_at, settled_at
)
```

`accepted_by` is null until acceptance, because until then the platform genuinely does
not know who the recipient is. That is the point: an invitation is addressed to an
identifier, not to a principal.

## The identifier is hashed, and salted per scope

The plaintext address is never persisted. An invite table full of addresses is a
mailing list, and a breach of it is a breach of everyone who was ever invited anywhere.

The salt is the **scope**, not a global constant. A global salt would make one address
produce one hash everywhere, so anyone holding the table could correlate a person
across tenants — reintroducing exactly what per-tenant identity pools exist to prevent.
Identifiers are normalised before hashing, so `A@b.com` and `a@b.com ` are one person.

## Invariants

**Re-inviting is indistinguishable from inviting.** Sending to someone who already has
an open invitation returns the existing id, in the same shape as a first send. Saying
"already invited" would let a sender probe membership one address at a time.

**Every failed accept returns one identical error.** Wrong identifier, unknown
invitation, already settled, expired — all the same message. Distinguishing them would
make the endpoint an oracle.

**Expiry is applied on read and on transition**, never by a background sweep. An
expired invitation must never be acceptable, and the only moments that matters are when
someone looks or someone acts. A sweep would be a second source of truth for the same
fact.

**Open invitations are bounded** — 25 per sender per organization, 14 days by default.
The limit counts *open* invitations rather than lifetime sends, or a busy admin would
eventually be locked out forever.
