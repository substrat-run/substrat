# @substrat-run/engine-invites

Invitations: the way a person joins an organization they are not already in.

The engine owns the state machine — `invited → accepted | revoked | expired`. It does
**not** own the membership. Membership is tenant-wide directory state, so accepting an
invitation emits `member.add-requested` and a privileged executor effects it
(K-22 §4.2). The engine's job ends at "this person said yes".

## The two properties that matter

**Non-enumerable.** Identifiers are stored hashed and never returned — not in a list,
not in an event, not in an error. A non-member, a decline, and an already-invited
person are indistinguishable to the sender, so the invite surface can never be used to
ask *"is this person on the platform?"*. Every bad accept returns one identical error
for the same reason: distinguishing them would make it an oracle.

**Accept-required.** An invitation confers nothing until the recipient acts, and
accepting re-hashes the identifier they present. A leaked invitation id is therefore
not a bearer token for someone else's invitation.

The hash is salted **per scope**. A global salt would make one address produce one hash
everywhere, reintroducing cross-tenant correlation through the back door — the property
per-tenant identity pools exist to prevent (kernel-design §4.3).

## Surface

```ts
sendInvite(ctx, { orgId, identifier, roleKey, ttlMs? })  // → { id }
acceptInvite(ctx, { invitationId, identifier })          // → Invitation
revokeInvite(ctx, invitationId)
listInvites(ctx, orgId)                                  // → Invitation[] (never the hash)
```

Operations are the thin bindings: `invites/send`, `invites/accept`, `invites/list`,
`invites/revoke`. **`invites/accept` checks no permission**, deliberately — the
recipient is not yet a member of anything, so there is no grant they could hold. The
invitation is the authority.

Verticals compose the exported functions in their own operations (K-16), in the same
transaction, having checked their own permission first.

## Bounded by design

Invitations expire (14 days by default) and one sender may hold 25 open invitations per
organization. Expiry is applied on read and on transition rather than by a sweep — an
expired invitation must never be acceptable, and a background job would be a second
source of truth for the same fact.

## Documentation

**https://substrat.net/engines** — the domain model and invariants, the operation/permission
surface, the event contracts, and how a vertical composes or extends it.

The docs site is the single source of truth; this README deliberately doesn't restate it.
