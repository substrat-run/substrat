---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
'@substrat-run/connector-mail-in': minor
'@substrat-run/control-plane': minor
---

Inbound mail (#2611). A scope can have an address on the platform's receiving subdomain (`in.substrat.run`) that mail is forwarded to, and each message lands through the operation its vertical declares (`connections: [{ provider: 'mail-in', operation, permission }]`), with attachment bytes stored on the entity that operation answers. Each address is its own `mail-in` connection: granted the declared key on its one scope, rotatable (mail in flight moves to the new address) and revocable, and the actor of everything a delivery writes. Unknown or revoked addresses, messages over 25 MiB and senders off an address's allowlist are refused at SMTP time; an allowlisted sender must be proven by DMARC/DKIM for `From:` or SPF for the envelope, read from the receiving MX's own stamp only. Accepted mail is stored before the SMTP answer, deduplicated on `Message-ID`, delivered straight away and retried by the connector pass, and dead-lettered after eight attempts. contracts: `mailInChange`, `mailInMessageAnswer`, `mailInAddress`, the relay shapes and limits. vertical-host: `mailInAddress` asks for, reads, rotates or revokes the scope's address from the vertical's worker (a proven caller is required).
