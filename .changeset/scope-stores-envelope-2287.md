---
'@substrat-run/contracts': minor
'@substrat-run/control-plane': patch
'@substrat-run/router': patch
---

A scope-store call carries an Ed25519 signature over the audience, the object name, the operation and the body (#2287). The router signs audience `caller` and the control plane signs audience `platform`, each with its own key. A store script holds only the public keys.
