---
'@substrat-run/engine-invites': minor
---

`readInvitation(ctx, invitationId)`: one invitation by id as a pure read. Like `listInvites`, an overdue invitation reports `expired` without the row being touched, and nothing is sent, counted against the rate limit or emitted. Additive; it returns the same published shape and never the identifier hash.
