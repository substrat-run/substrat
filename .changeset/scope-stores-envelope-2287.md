---
'@substrat-run/contracts': minor
'@substrat-run/control-plane': patch
'@substrat-run/control-plane-api': minor
'@substrat-run/router': patch
---

A scope-store call carries an Ed25519 signature over the audience, the key id, the store script, the object name, the operation, the body, the issue time and a nonce (#2287). The router signs audience `caller` and the control plane signs audience `platform`, each with its own key. A store script holds only public keys, a list per audience so a key can rotate, and checks every call with `verifyScopeStoreCall`. A public key listed for both audiences, or spelled in non-canonical base64url, is refused (`scopeStorePublicKeysFrom`). `PlatformScopeStoreDispatch.hmacKey` is now `platformKey`, a PKCS8 Ed25519 key. The name-only `signScopeStoreName` / `verifyScopeStoreName` and the `./scope-store-mac` subpath are removed.
