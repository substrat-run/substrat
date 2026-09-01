# Invites: operations & permissions

## Permissions

| Key | Holder |
|---|---|
| `invites:send` | whoever may add people to an organization |
| `invites:read` | whoever may see pending invitations and their state |
| `invites:revoke` | whoever may withdraw an unaccepted invitation |

## Operations

```
invites/send    { orgId, identifier, roleKey, ttlMs? }  → { id }
invites/accept  { invitationId, identifier }            → Invitation
invites/list    { orgId, limit?, cursor? }              → Page<Invitation>
invites/revoke  { invitationId }                        → void
```

Each is the thin binding the engine convention requires: a permission check plus one
exported in-scope function.

`invites/list` answers a **page**, newest first, walked by `id` — a ULID, so it carries
the same instant `created_at` does and is unique, which a cursor must be. The in-scope
`listInvites` stays unpaged: a vertical composing it is reading one org's invitations to
decide something, not rendering a table.

## In-scope functions

The composable surface. A vertical calls these **inside its own operation**, in one
transaction — this is how you extend the engine without forking it. For every one of them
except `acceptInvite`, the caller owns the permission check; **`acceptInvite` must not be
gated**, for the reason below, and putting it behind a permission key is how you lock out
the invitees the invitation was issued to.

```ts
sendInvite(ctx, { orgId, identifier, roleKey, ttlMs? })  → Promise<{ id }>
acceptInvite(ctx, { invitationId, identifier })          → Promise<Invitation>
listInvites(ctx, orgId)                                  → Invitation[]
revokeInvite(ctx, invitationId)                          → void
expireOverdue(ctx, orgId)                                → void
hashIdentifier(scopeSalt, identifier)                    → Promise<string>
```

Notes worth knowing:

- `sendInvite` hashes the identifier **before it is persisted or used in a lookup** — the
  plaintext never reaches storage and never appears in a `WHERE` clause. It also
  rate-limits open invitations per sender per organization, and answers `{ id }` and
  nothing about whether the recipient already exists, is already a member, or declined
  before — that uniformity is what keeps the surface non-enumerable.
- `acceptInvite` checks no permission (below) and re-hashes the presented identifier to
  compare. It emits `member.add-requested`; it does **not** write the membership.
- `expireOverdue` is called on the read and write paths inside the engine, so an overdue
  invitation is never acceptable even if no sweep has run. It is exported for a host that
  wants to run it on a schedule as well.
- `hashIdentifier` is exported because a *host* building an accept link needs the same
  comparison input. It is Web Crypto (`globalThis.crypto`), never a hand-rolled digest,
  and it is salted with the scope id — one address hashes differently in every tenant.

None of these check permissions themselves — for five of the six that is the caller's job,
by design; for `acceptInvite` there is no check to make.

## `invites/accept` checks no permission

Deliberately, and it is the one thing on this page worth arguing about.

The recipient is not yet a member of anything, so there is no grant they could hold. A
permission check would either be vacuous or would require granting access *before*
acceptance — which is precisely what accept-required exists to prevent.

The invitation is the authority, and it is proven rather than asserted: accept
re-hashes the identifier the caller presents and compares it to the stored hash. An
invitation id alone is not enough, so a leaked id is not a bearer token.

## What comes back

`Invitation` is the row **minus the identifier hash**. The hash never crosses the
engine boundary, because a leaked hash lets its holder confirm an address offline —
which is the enumeration the whole design exists to prevent.

```ts
type Invitation = {
  id: string;
  org_id: string;
  role_key: string;
  state: 'invited' | 'accepted' | 'revoked' | 'expired';
  invited_by: string;
  accepted_by: string | null;
  created_at: string;
  expires_at: string;
  settled_at: string | null;
};
```
