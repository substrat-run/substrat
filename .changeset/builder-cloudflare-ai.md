---
"@substrat-run/builder": minor
---

Cloudflare Workers AI as a builder model provider (OpenAI-compatible mode), local and hosted. The endpoint is account-scoped, so `CLOUDFLARE_AI_BASE_URL` carries the account id; the token is a dedicated `CLOUDFLARE_AI_API_TOKEN` with the Workers AI permission only — never wrangler's ambient deploy token. Model ids keep their catalog prefix: `@cf/…` runs on Cloudflare's network, bare `vendor/model` slugs are partner-served under unified billing (surfaced honestly in the model picker per D-53). Hosted secrets: `BUILDER_CLOUDFLARE_AI_BASE_URL` / `BUILDER_CLOUDFLARE_AI_API_TOKEN` in the secrets manifest.
