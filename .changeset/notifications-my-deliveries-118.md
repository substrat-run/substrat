---
"@substrat-run/engine-notifications": minor
"@substrat-run/demo-handlebar": minor
---

A person can read their own notification history (part of #118). `@substrat-run/engine-notifications` adds `notifications/my-deliveries`, under the existing `notifications:self` key (no new permission key), and the in-scope `listMyDeliveries`.

- It pages the caller's deliveries, newest first, and narrows by `status` and `topic`. It is `notifications/list-deliveries` with the caller's principal pinned in and no `principal` input, so holding the key never reaches anyone else's rows. An input that names one is dropped.
- The row is narrower than the administrator's (`myDeliveryRow`): no `principal`, no `dedupe_key` and no `request_id`. Its `reason` is kept on a `skipped` row, where it is the engine's own word (`muted`, `no_address`, `digest`, `quarantined`), and is `null` on a `refused` or `dead_lettered` one, whose reason is the platform's outcome code.
- Digest rows are listed as they are: an occasion held for the digest reads `skipped`/`digest` and is settled once its digest is written, the digest is a row of its own under `@digest`, and a withdrawn occasion reads `skipped`/`muted`.
- The description of `notifications:self` now says it covers reading what became of your notifications. The key's holders (in Handlebar, `mechanic` and `workshop-admin`) gain this one read of their own rows.

Handlebar serves it at `GET /me/notifications/deliveries` and its generated client gains `notificationsMyDeliveries`.
