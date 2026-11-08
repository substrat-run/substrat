---
'@substrat-run/adapter-sqlite': minor
'create-substrat': patch
---

`devMailOutbox(host, { dataDir, actor })` writes each mail a dev server's scopes queue with `requestEmail` to `.data/outbox/<request>.eml` (or `MAIL_OUTBOX_DIR`), logs one line naming the file, and settles it with `email.sent` as the platform's drain does hosted. Spread `outbox.kick(caller)` into `getScope` to write a mail as soon as the call that queued it commits. Locally a queued invitation went nowhere and said so nowhere. The template's `src/server.ts` wires it.
