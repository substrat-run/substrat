---
'@substrat-run/engine-invoicing': minor
---

`invoicing/export` takes an optional `currency`, so exporting a basis with no lines no longer invents `SEK` on the `invoicing.underlag-exported` total an accounting connector reads. Omitting it keeps today's answer; declaring one that contradicts the basis's lines is refused with `currency_mismatch` instead of ignored.
