---
status: built
layer: kernel
description: Invitations to an organization, and the connector seam that effects membership.
---

# `engine-invites` — the invitation, and the seam it cannot cross

Status: **built** — `@substrat-run/engine-invites`, live on npm.

> **Written after the fact**, from the source. This engine predates the convention of
> writing an engine design document. The membership seam it sits on *is* argued at length,
> in [architecture/membership.md](../architecture/membership.md) and K-21/K-22 — this
> describes the engine, not that argument.

**Composed by call**, with one deliberate exception: accepting an invitation checks no
permission at all (§4). It is D-31's "two consumers on day one" case — Substrat's own
dashboard and every hosted vertical need the same invitation surface, which is why it is an
engine rather than control-plane plumbing.

## 1. The one table

```sql
CREATE TABLE invites_invitation (
  id, org_id, identifier_hash, role_key, state,
  invited_by, accepted_by, created_at, expires_at, settled_at
);
CREATE INDEX invites_by_org ON invites_invitation (org_id, state);
```

**The invitee's identifier is never stored.** Only `identifier_hash` — and the hash is
salted with `ctx.scopeId`, so the same email produces a *different* hash in every scope.
The reason is stated in the source: an unsalted hash would be the same value in every
tenant, which reintroduces cross-tenant correlation through the back door. The public row
type is `Omit<InvitationRow, 'identifier_hash'>`; the hash does not leave the engine.

That is also why there is no "list invitations by email" — the engine cannot answer it, by
construction rather than by omission.

## 2. State machine

```
invited ──accept──▶ accepted
   │
   ├──revoke────▶ revoked
   └──expire────▶ expired      (expires_at passes; recorded by expireOverdue)
```

`invited` is the only unsettled state. `settled_at` is stamped on all three terminal
transitions, so "is this still live" is one predicate.

Expiry is the one transition time makes rather than a person, so it is **rendered on read
and recorded on write** (#964). The projection applies to `invited` rows and only those:
`listInvites` reports `expired` for a still-`invited` invitation whose `expires_at` has
passed, without touching the row — a read under `invites:read` settles nothing — while
`sendInvite` and the accept path call `expireOverdue` and stamp `settled_at` for real. An
`accepted` or `revoked` invitation reads back exactly as stored, `settled_at` and all, no
matter how long ago its deadline went by. So the only row that reads `expired` with a null
`settled_at` is one time lapsed and nobody has since met, and that null is a fact: the
transition has not been recorded yet.

## 3. The acceptance path, and why it refuses to be an oracle

`acceptInvite` validates in this order — and returns **the same error for every failure**:

```
invitation is not acceptable
```

Not found, wrong state, expired, and identifier-mismatch are indistinguishable to the
caller. The source says why: distinguishing them would turn the accept endpoint into an
oracle — a caller could enumerate which invitation ids exist, or confirm that a given email
was invited to a given org. The uniform refusal costs a little debuggability and buys that.

Expiry is enforced *here*, on the write, not left to a sweep: `acceptInvite` refuses an
overdue invitation and records the transition through `expireOverdue` at the moment someone
tries to use it, so a lagging sweep never widens the window. A read is where expiry is
merely *shown* (§2) — `listInvites` renders `expired` and settles nothing — and the two
never disagree about what is acceptable, because the accept path is the one that decides.

## 4. Permissions — and the one operation that has none

`invites:send` · `invites:read` · `invites:revoke`, each with the description the manifest
declares, at
[`apps/docs/engines/invites/surface.md`](../../apps/docs/engines/invites/surface.md#permissions).

**Accepting checks nothing.** The invitation *is* the authority — you hold a link naming an
id and can produce the identifier it was issued to, and that is the whole credential
(membership.md §6). A permission check would be incoherent: the acceptor is by definition
not yet a member, so there is no node at which they hold anything.

That has a UI consequence the manifest states rather than leaves implicit: there is
deliberately **no accept route** among the contributed screens. An accept screen belongs in
the host app's unauthenticated routing, outside the permission-keyed shell — putting it in
the shell would gate the one flow that must work for someone with no grants.

Entitlement key: `invites`. `attachmentTargets` is empty — an invitation is not a thing you
attach documents to.

## 5. In-scope exports

**The signatures live in one place, and it is not here:**
[`apps/docs/engines/invites/surface.md`](../../apps/docs/engines/invites/surface.md#in-scope-functions),
published at [substrat.net/engines/invites/surface](https://substrat.net/engines/invites/surface).
This page restated four of the six — `sendInvite` and `acceptInvite`, the two that carry the
whole design, were never in the copy — which is what [`docs/README.md`](../README.md) means
by *nothing belongs in both*. The reasoning behind them is §3 and §6 here.

## 6. Events — and the seam the engine cannot cross

All four — `invites.sent`, `invites.accepted`, `invites.revoked` and
`member.add-requested`, all v1 — are at
[`apps/docs/engines/invites/events.md`](../../apps/docs/engines/invites/events.md)
(published at [substrat.net/engines/invites/events](https://substrat.net/engines/invites/events)).
`consumes` is empty. The argument below is what belongs here.

The fourth is the interesting one. **The engine cannot write a membership tuple.**
Membership is tenant-wide directory state, in a different Durable Object, outside this
scope's transaction — so an in-scope membership write would be a two-phase write with no
coordinator, and a rollback after the directory write lands would orphan the membership
(K-22 §4.2).

So the engine does not write it. It **asks**:

```
invites.accepted        →  the vertical's own record-keeping
member.add-requested    →  a privileged executor, outside module code,
                           which effects membership through the host admin surface
```

The request event is **fat by requirement** (D-19): it carries `principal`, `orgId`,
`tenantId`, `roleKey` and `invitationId`, because the executor must never need a
cross-module read to act. Atomic where it counts — a rollback leaves no event and therefore
no membership change.

`invites.accepted` carries `principal`, a ULID that names nobody outside the platform; the
identifier never appears in a payload. All four events are `piiClass: 'none'`, which is only
true *because* of the hashing decision in §1.

## 7. Open questions

1. **Acceptance is eventually consistent, and the trail splits.** The membership lands via
   the executor after the scope transaction commits, so there is a window in which an
   invitation is `accepted` and the membership is not yet effected. K-22 specifies prompt
   inline dispatch with the outbox as the durability backstop, and a correlation id joining
   the two log entries — worth verifying against the executor as built rather than as
   designed.
2. **No revocation of an accepted invitation.** `revokeInvite` leaves settled invitations
   alone by design; removing the resulting membership is `unassignRole`, a different surface
   (dashboard-teams §7). Nothing links the two, so "undo this invitation" is two acts.
3. **`expireOverdue` has no automatic caller inside the engine.** It is exported for a host
   to schedule; `sendInvite` and the accept path in §3 call it, and that is what makes it
   safe to forget. Since #964 the read path does *not*: a row can therefore sit `invited`
   in storage while every reader is told `expired`, which is the divergence the original
   read-path write avoided. The two never disagree about what is *acceptable* — accept
   settles the row it refuses — so what is open is whether anything should record the
   transition (an `invites.expired` event, and a sweep to emit it) or whether "expired" is
   correctly a fact about the clock that nothing needs to announce.
