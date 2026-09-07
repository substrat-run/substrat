---
'create-substrat': patch
---

The template's `AGENTS.md` now lists `operation` and `version` among the fields
`readHistory` returns, beside the payload, the authorization chain, the
impersonation stamp and the PII class — and says what each field's `null` means,
and that `version` is read from the outbox column rather than the event envelope.
