# @substrat-run/model-providers

## 0.4.2

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
  - @substrat-run/contracts@0.99.0

## 0.4.1

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
  - @substrat-run/contracts@0.98.0

## 0.4.0

### Minor Changes

- cc1bbcd: Cloudflare's Workers AI models carry a price. The rate card was four models chosen by hand — right while the models are ours to pick, wrong once a tenant picks one from the provider's own catalogue, because everything outside the four priced at nothing: metered, reported, billed $0, silently. The generator now expands a whole provider catalogue model-by-model, cross-checked against LiteLLM exactly as an authored row is, and Cloudflare is the first one in: all 27 `@cf/…` models, with cache-read rates where the provider publishes one. Partner-served `vendor/model` ids stay unpriced on purpose — the picker keeps them free text, and billing inference Cloudflare does not host is a decision rather than a missing row.

### Patch Changes

- Updated dependencies [9fcfebc]
  - @substrat-run/contracts@0.97.0

## 0.3.2

### Patch Changes

- Updated dependencies [db5a3da]
  - @substrat-run/contracts@0.96.0

## 0.3.1

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0

## 0.3.0

### Minor Changes

- 35147a9: Hosted verticals reach Workers AI through a **binding**, not a credential (#1054). A provider row may declare `binding`, meaning it is also reachable through a runtime capability rather than over HTTP with a token; `createModelHost({ aiBinding: env.AI })` supplies it, and the control plane binds `env.AI` on every pushed script. The `cloudflare` row is then runnable with no `CLOUDFLARE_AI_*` set anywhere — nothing on the script to read, leak or rotate, and Workers AI bills the account that owns it. The HTTP transport is unchanged for hosts that have a token (the local builder studio). Also replaces the default model: `@cf/meta/llama-3.1-8b-instruct` was deprecated on 2026-05-30 and fails at runtime; the default is now `@cf/meta/llama-3.1-8b-instruct-fast`.

### Patch Changes

- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0

## 0.2.0

### Minor Changes

- 4bbcf6b: Cloudflare's AI Gateway extras as properties of its row (#1054, step 5). `requestHeadersFor(provider, { attribution, env })` returns the per-request headers a row's endpoint wants: for `cloudflare`, the five attribution keys as `cf-aig-metadata`, `cf-aig-collect-log-payload: false` so the gateway never retains a prompt or an answer, and `cf-aig-gateway-id` when `CLOUDFLARE_AI_GATEWAY_ID` names one; for every other row, nothing. The model host attaches them to each call without knowing which case it is in. A sixth metadata key is refused rather than silently dropped.
- f93cab4: New package `@substrat-run/model-providers` — the model-provider seam extracted from the builder studio (#1054, step 1). One `provider:model` grammar, one table of providers (Anthropic, OpenAI, Google, Mistral, Qwen, Cloudflare, Scaleway, Ollama, any OpenAI-compatible endpoint), the hosting disclosure per row, the generated rate card and the list-price math over it. A host differs from another only in where credentials come from and how direct-provider packages get loaded — both are parameters of `createModel` — so a Worker and the Node CLI resolve the same table without a provider-specific path. Cloudflare is one `compatible` row; its gateway features are extras a host layers on that row, never a second code path. The builder keeps only what is its own: `process.env` + dynamic imports locally, static factories hosted, the 20% studio markup, and the phase→tier mapping for `provider:auto`. The rate card regenerates with `pnpm --filter @substrat-run/model-providers update-rate-card`.

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
  - @substrat-run/contracts@0.93.0
