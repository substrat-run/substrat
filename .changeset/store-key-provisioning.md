---
"@substrat-run/contracts": minor
---

`scopeStoreSignerPublicKey(pkcs8)` names the raw public key and key id a scope-store signing key signs under, derived exactly as `issueScopeStoreEnvelope` derives them, and throws `ScopeStoreKeyError` (whose message never carries the key) when the key is unusable. The signer now keeps its private key non-extractable.
