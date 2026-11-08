---
'@substrat-run/contracts': minor
---

A mail-in landing can keep the original message: answer the `message` change with `{ entity, raw: true }` and the message's bytes are stored on that entity as `message.eml` (`message/rfc822`), followed by a new `raw` change on `mailInChange` before any `attachment` change. At least once, keyed by `messageId`. An answer without `raw` delivers as before.
