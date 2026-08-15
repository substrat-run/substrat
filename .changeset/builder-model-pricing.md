---
"@substrat-run/builder": patch
"@substrat-run/builder-web": patch
---

Builder usage pricing: the studio's meter keys now carry the model as the billing dimension (`ai.tokens.{input,output}.<provider:modelId>`, configured lazily per model — engine-metering's "subject ≠ meter dimension" rule, since price varies by model), and a vertical-side rate card (`pricing.ts`, D-E: the engine owns quantities, never prices) prices each model's tokens at provider list + 20% markup. Seeded with Qwen 3.6 Flash ($0.19/$1.13 per 1M in/out) and Qwen 3.8 Max ($2.00/$6.00), longest-prefix matched so dated snapshots price as their base model. `/api/usage` gains `byModel` rows with `listUsd`/`billedUsd` (exact decimal strings via contracts helpers; token-millions convert exactly at 6 dp) plus a `cost` rollup that only sums priced rows — models without a rate card entry (all Anthropic models today) count as `unpricedTokens`, never a guessed $0. The Usage pane shows a cost tile and a per-model table with list and billed columns; pre-model v0 entries fold in as unattributed.
