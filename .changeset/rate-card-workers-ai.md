---
'@substrat-run/model-providers': minor
---

Cloudflare's Workers AI models carry a price. The rate card was four models chosen by hand — right while the models are ours to pick, wrong once a tenant picks one from the provider's own catalogue, because everything outside the four priced at nothing: metered, reported, billed $0, silently. The generator now expands a whole provider catalogue model-by-model, cross-checked against LiteLLM exactly as an authored row is, and Cloudflare is the first one in: all 27 `@cf/…` models, with cache-read rates where the provider publishes one. Partner-served `vendor/model` ids stay unpriced on purpose — the picker keeps them free text, and billing inference Cloudflare does not host is a decision rather than a missing row.
