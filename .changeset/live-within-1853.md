---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/demo-ticket0': minor
---

A live read can be narrowed to one entity, and ticket0's widget is pushed to instead of polling (#1853).

- `liveReads.subscribe` takes an optional `within`. Given an `EntityRef`, the feed carries only frames whose entity is that one or reaches it through live declared parent edges (what `ctx.link` and `ctx.relink` write). This is the walk a permission check makes, now exported as `reachesWithin`. The principal's own check still runs, so `within` only ever removes frames.
- `within: vouchedWithin(entity, { because })` is for a subscriber with no principal of its own, after the vertical has proven it may watch `entity`. The principal's check is then not applied: the walk is the whole filter. Every frame is a `LiveNudge` (`{ kind: 'nudge', id, at }`), naming no event type and no entity. Only a value built by `vouchedWithin` reaches this mode. A look-alike object is refused when you subscribe.
- On Cloudflare, the walk runs once per row and root in each post-commit pass, however many sockets share the root. A socket whose stored narrowing cannot be read is dropped rather than widened. A socket opened before this release stays unnarrowed.
- ticket0: the widget opens `GET /widget/sessions/:id/live` once it has a session and re-reads its thread on each nudge. Polling stays underneath: at the old pace with no socket, and a 60-second floor with one. The new `ticket0/widget-watch` operation proves the session token first. The feed is rooted at the visitor's session. Each public message on the session's conversation is linked under it, so internal notes, drafts and other visitors' chats send nothing.
- ticket0: when a closed conversation's visitor writes again, their session is now relinked onto the follow-up rather than linked to both. A session therefore has one parent, its current conversation. Migration `0024` repairs sessions moved before this release and back-fills the message edges.
