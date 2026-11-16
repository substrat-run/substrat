---
'@substrat-run/engine-protocol': minor
'@substrat-run/connector-scrive': patch
---

`requestSignatures` accepts a request with a single party. That party is the primary and is invited to sign, so a one-off offer only the customer signs no longer needs the sender named as a second signer. Every party now needs a `contact`, the primary included, and a party without one is refused before the instance freezes. Before, Scrive refused it after the freeze and the instance was left waiting.
