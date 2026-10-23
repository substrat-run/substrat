---
"@substrat-run/contracts": minor
---

Add `@substrat-run/contracts/wire-signing`: the primitives of a proposed signed envelope for calls from the platform to a deployed vertical (RFC wire-signing). It covers the canonical encoding, the Ed25519 signer, the verifier and the nonce-cache interface. The verifier returns one refusal value for every failure the caller caused, and a callback receives the reason for metrics. A misconfigured deployment throws instead, including a call verified without a stated replay policy. Key forms, key ids and key lists are the scope-store envelope's. Nothing in the platform signs or verifies one yet, so no request is handled differently.
