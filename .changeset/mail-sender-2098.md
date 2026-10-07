---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-email': minor
---

A vertical can now send email as a tenant's own address, not only as the platform's (#2098). The email relay accepts an optional `from`. Without one, nothing changes: the message goes out from the platform's sender. With one, the relay sends through the tenant's live connection whose mail sender may send as that address, and only when the platform has proven which vertical is calling. An address no connection covers is refused by name. The relay never falls back to the platform's sender, and two connections claiming one address are refused rather than chosen between.

`@substrat-run/kernel`: `MailSender` is the interface a connector implements to send as the tenant. `senders(host, connection)` answers which addresses the connection may send as, and `send(host, connection, mail)` sends one `OutboundMail`. No connector implements it yet; Microsoft 365 is the first planned (#2100).

`@substrat-run/contracts`: `emailRelayRequest` gains `from` and `attachments` (attachment ids, at most `EMAIL_RELAY_MAX_ATTACHMENTS`). Attachments ride only with `from`. They are read from the sending scope as the tenant's connection, so a file can go out only when that connection was granted read on the attachment's target.

`@substrat-run/adapter-email`: `EmailMessage.attachments` carries files as bytes (`{ filename, contentType, content }`), which `CloudflareEmailTransport` sends, or by id (`{ attachmentId }`), which only `PlatformRelayEmailTransport` carries. The relay transport's new `sender: 'from'` option asks the relay to send as the message's `from.email`. The default, `'platform'`, ignores that address as before, so existing callers that fill `from` with a placeholder keep working.
