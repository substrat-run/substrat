# @substrat-run/model-providers

## 0.2.0

### Minor Changes

- 4bbcf6b: Cloudflare's AI Gateway extras as properties of its row (#1054, step 5). `requestHeadersFor(provider, { attribution, env })` returns the per-request headers a row's endpoint wants: for `cloudflare`, the five attribution keys as `cf-aig-metadata`, `cf-aig-collect-log-payload: false` so the gateway never retains a prompt or an answer, and `cf-aig-gateway-id` when `CLOUDFLARE_AI_GATEWAY_ID` names one; for every other row, nothing. The model host attaches them to each call without knowing which case it is in. A sixth metadata key is refused rather than silently dropped.
- f93cab4: New package `@substrat-run/model-providers` — the model-provider seam extracted from the builder studio (#1054, step 1). One `provider:model` grammar, one table of providers (Anthropic, OpenAI, Google, Mistral, Qwen, Cloudflare, Scaleway, Ollama, any OpenAI-compatible endpoint), the hosting disclosure per row, the generated rate card and the list-price math over it. A host differs from another only in where credentials come from and how direct-provider packages get loaded — both are parameters of `createModel` — so a Worker and the Node CLI resolve the same table without a provider-specific path. Cloudflare is one `compatible` row; its gateway features are extras a host layers on that row, never a second code path. The builder keeps only what is its own: `process.env` + dynamic imports locally, static factories hosted, the 20% studio markup, and the phase→tier mapping for `provider:auto`. The rate card regenerates with `pnpm --filter @substrat-run/model-providers update-rate-card`.

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
  - @substrat-run/contracts@0.93.0
