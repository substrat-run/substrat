---
"@substrat-run/contracts": minor
---

Scope-store keys can be judged without parsing error text. `scopeStoreSignerPublicKey(pkcs8)` names the raw public key and key id a signing key signs under, derived exactly as `issueScopeStoreEnvelope` derives them. `scopeStorePublicKeyProblem(key)` returns why a store refuses one configured public key (`empty`, `length`, `small-order`, `non-canonical`), and `parseScopeStorePublicKeys` is built on it. `ScopeStoreKeyError` now carries a `reason` (`encoding`, `not-ed25519`, `no-public-half`, `small-order`), and a signing key whose public half is a small-order point is refused as a `ScopeStoreKeyError` instead of a plain `Error`.
