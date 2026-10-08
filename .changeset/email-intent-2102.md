---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
'@substrat-run/adapter-email': minor
---

An operation can now send email as part of its own transaction (#2102). `requestEmail(ctx, mail)` writes the send as a platform intent. If the operation fails, nothing is sent. Once it commits, the platform sends the mail, as the platform's address or through the tenant mailbox that covers `from`, exactly as the relay routes it. A throttled or failing provider is retried, waiting as long as the provider's `Retry-After` asks, and the result comes back as an event the vertical can consume: `email.sent` (with the provider's message id when it gives one), `email.refused`, or `email.dead-lettered` after 10 transient failures. Each event names the request id `requestEmail` returned. It is written on the `about` entity when the mail names one. Passing the recipient's `subjectId` classifies the queued send, so a subject erasure cancels it and removes the address and message. The synchronous relay is unchanged and stays for code with no operation around it.

`@substrat-run/contracts`: `SEND_EMAIL_KIND`, `sendEmailRequest`, the three outcome event types (kernel-authored, so `ctx.emit` refuses them), `emailOutcomePayload`, and `platformOutcomeEvent`, the one shape a settle may write.

`@substrat-run/kernel`: `requestEmail`, and `settlePlatformRequestIn`, the settle both adapters now share. A settle may carry one outcome event. It is written in the settle's transaction, and only when that settle moves the row out of `pending`. `MailSendResult` gains an optional `messageId`, and `MailSender.send` documents the error contract the retry reads: a numeric `status`, and `retryAfter` in seconds.

`@substrat-run/adapter-sqlite`, `@substrat-run/adapter-cloudflare`: `settlePlatformRequest` accepts `event` and dispatches it to the scope's consumers. The Durable Object takes it through a new `settlePlatformRequestWithEvent` verb, so a settle without an event still reaches an older DO class.

`@substrat-run/control-plane-api`: `sendEmailHandler` for the drain. A handler may return `deferred` (not tried, no attempt counted), and an outcome's `event` is passed to the settle.

`@substrat-run/vertical-host`: the settle route accepts the event.

`@substrat-run/contract-tests`: the evented settle is in the scope-host contract.

`@substrat-run/adapter-email`: `SendResult.messageId`, read from Cloudflare Email Service's response.
