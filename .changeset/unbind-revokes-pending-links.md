---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
---

Unbinding a record now revokes its pending binding links in the same transaction, and the unbind answers `revokedLinks`: a link must not outlive the binding it was made for.
