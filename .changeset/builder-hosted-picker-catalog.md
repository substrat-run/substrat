---
"@substrat-run/builder": patch
---

Hosted studio: the model picker now works. `GET /api/providers` and `GET /api/models`
were still falling through to the "not hosted yet" 503, so the picker on
builder.substrat.net rendered no provider rows and every session was pinned to the
default `anthropic:claude-opus-5` — even when the only credentials deployed were
Qwen/Cloudflare worker secrets. `providers-worker.ts` now serves the hosted catalog
(the same four providers `resolveModelHosted` can run, with the D-53 who/where/what
disclosure and `credential.set` read from worker secrets) plus live `/models` listing
for the OpenAI-compatible endpoints, and the DO routes both endpoints.
