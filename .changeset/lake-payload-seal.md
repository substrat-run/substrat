---
"@substrat-run/kernel": minor
"@substrat-run/contracts": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/control-plane": patch
---

The lake drain can seal each event's personal data under its subject's own key, so an erasure reaches the lake copy (#3464, K-37 limit 6). `drainScopeEvents` takes `sealEventPayloads`. With it set, every classified payload is sealed through `sealSubjectPayloads` in one call per batch, and ships in the backup cell's `{"__sealed": …}` shape, which contracts now publishes as `lakeSealedPayload`. A tombstoned subject's payload ships as `null`, and a seal that fails ships and stamps nothing. The control plane turns it on with `LAKE_PAYLOAD_SEAL=on`, which is off by default, for the pass and a scope's kicked drain alike. `createSubjectKeys` reads a batch's keys in one call (`SubjectKeyRecords.readMany`, which both adapters fill). It also re-reads after minting, so a sealer that loses the insert to another sealer uses the stored key, and one that loses to a shred refuses.
