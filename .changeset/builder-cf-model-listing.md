---
"@substrat-run/builder": patch
---

Cloudflare model listing: Workers AI's OpenAI-compatible surface serves
chat/completions and embeddings but not `GET /models` — the picker's live
listing 405'd. Both hosts now read the account catalog instead
(`…/ai/models/search`, derived from the `/ai/v1` base), filtered server-side
to Text Generation so the list is models that can actually run a build turn.
Cloudflare's own `@cf/…` models only; partner-served `vendor/model` ids stay
free-text.
