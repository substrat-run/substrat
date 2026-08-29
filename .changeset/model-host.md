---
"@substrat-run/contracts": minor
"@substrat-run/vertical-host": minor
---

The platform's model host (#1054, step 2). `@substrat-run/vertical-host/model` exports `createModelHost({ env, factories, guard, record })`: resolve a `provider:model` against platform-held credentials, consult the host's policy before the bytes go out, run the call, and produce one `ModelUsageLine` — token counts as the provider reported them (`reported: false` when it reported none, never an estimate), list price from the rate card on our side, attributed with the five fixed keys — handed to the host's ledger. Provider-neutral by construction; it lives around operations, never inside a scope's transaction. Contracts gains `modelAttribution` and `modelUsageLine`, the shared vocabulary the control plane will parse at the drain.
