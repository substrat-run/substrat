---
'@substrat-run/contracts': minor
'@substrat-run/control-plane': patch
---

Mail-in addresses have abuse limits: `MAIL_IN_MAX_MESSAGES_PER_HOUR` (60) and `MAIL_IN_MAX_BYTES_PER_DAY` (250 MiB) per address, refused at SMTP time past either.
