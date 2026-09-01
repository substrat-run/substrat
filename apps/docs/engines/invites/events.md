# Invites: events

## Emitted

| Type | Version | When |
|---|---|---|
| `invites.sent` | 1 | a new invitation is recorded |
| `invites.accepted` | 1 | the recipient accepts |
| `invites.revoked` | 1 | an unaccepted invitation is withdrawn |
| `member.add-requested` | 1 | on acceptance — the membership request |

## Consumed

**None.** `consumes` is empty: this engine is a pure producer. An invitation is started by
a call, never by another module's event.

All payloads are `piiClass: 'none'` and **contain no identifier**. The event spine
outlives the row it describes, so an address leaked here is leaked for as long as
history is kept.

`invites.accepted` carries `{ invitationId, orgId, roleKey, principal }`. The
`principal` is who accepted — a ULID, so it names nobody outside the platform, and a
vertical creating its own record for that person needs it. Without it the event would
describe an acceptance by no one, which is precisely what the first vertical to consume
it discovered.

## `member.add-requested` is the interesting one

The engine cannot write a membership tuple. Membership is tenant-wide directory state,
outside this scope's transaction — so the engine *asks*, and a privileged
[executor](/concepts/events#the-connector-seam) effects it.

```ts
{
  principal,      // who accepted
  orgId,          // which organization
  tenantId,
  roleKey,        // what the invitation offered
  invitationId,   // provenance
}
```

The payload is deliberately **fat**: the executor must never need a cross-module read
to act on it.

This is also why acceptance is atomic in the way that matters. `ctx.emit` commits with
the engine's own write, so an accept that fails leaves no event and therefore no
membership. An in-scope cross-database write could not offer that — it could land in
the directory and then be orphaned by the scope's rollback.
