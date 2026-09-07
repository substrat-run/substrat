---
'@substrat-run/engine-invites': minor
---

**engine-invites: listing invitations no longer changes them.**

`invites/list` runs under `invites:read`, and it used to settle the organization's
overdue invitations on its way past — a state transition inside a read, recorded by
no event, and different on the second call than the first. Opening a screen was a
write.

It renders that state now instead of recording it. An invitation whose `expires_at`
has passed comes back as `expired` exactly as before, with its row untouched: the
same list twice answers the same thing and writes nothing either time, so the read
is safe to retry and safe to cache. Because nothing recorded the transition,
`settled_at` stays `null` on such an invitation until a write path meets it — and
that null is a fact worth reading, not missing data.

Nothing became more permissive. An overdue invitation is still unacceptable, and
`sendInvite` and the accept path still call `expireOverdue` and stamp `settled_at`
for real — which is also what keeps the open-invitation rate limit counting only
invitations that are genuinely open.

New export: `effectiveStateOf(state, expiresAt, now)`, the one comparison behind
that rendering, for a vertical folding `listInvites` into a read of its own.
