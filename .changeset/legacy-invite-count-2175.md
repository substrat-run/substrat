---
'@substrat-run/vertical-auth': minor
---

Measure the legacy hash-only invites still pending (#2175).

`IdentityDO.legacyInviteCount(scopeId)` counts a scope's unclaimed invites that carry no capability — the rows only the legacy branch of `acceptMemberInvite` can still serve. The invite routes write a `legacy-invites-pending` warn line (`scopeId`, `pending`, `via`; no address, token or principal): from `GET /api/invites` only while `pending` is above zero and at most once an hour per scope per isolate, and from every accept that claims an invite through the legacy branch. An hour with no line from a deployment that is read means nothing is left to retire. Additive: `legacyInviteCount` is optional on `InviteDirectory`, and `legacyInviteListReporter` is exported for a door that lists invites itself.
