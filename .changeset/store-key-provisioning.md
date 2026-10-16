---
"@substrat-run/contracts": minor
---

Scope-store keys can be judged without parsing error text. `scopeStoreSignerPublicKey(pkcs8)` names the raw public key and key id a signing key signs under, derived exactly as `issueScopeStoreEnvelope` derives them. `scopeStorePublicKeyProblem(key)` returns why a store refuses one configured public key (`empty`, `length`, `small-order`, `non-canonical`), and `parseScopeStorePublicKeys` is built on it. `ScopeStoreKeyError` now carries a `reason` (`encoding`, `not-pkcs8-v1`, `not-ed25519`, `no-public-half`, `small-order`), and a signing key whose public half is a small-order point is refused as a `ScopeStoreKeyError` instead of a plain `Error`. A signing key must be exactly the 48-byte Ed25519 PKCS8 v1 form `generateScopeStoreKeyPair` writes: the signer used to pass whatever the runtime's DER parser tolerated, trailing bytes included, and runtimes differ there.
