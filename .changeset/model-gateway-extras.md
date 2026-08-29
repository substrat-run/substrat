---
"@substrat-run/model-providers": minor
"@substrat-run/vertical-host": patch
---

Cloudflare's AI Gateway extras as properties of its row (#1054, step 5). `requestHeadersFor(provider, { attribution, env })` returns the per-request headers a row's endpoint wants: for `cloudflare`, the five attribution keys as `cf-aig-metadata`, `cf-aig-collect-log-payload: false` so the gateway never retains a prompt or an answer, and `cf-aig-gateway-id` when `CLOUDFLARE_AI_GATEWAY_ID` names one; for every other row, nothing. The model host attaches them to each call without knowing which case it is in. A sixth metadata key is refused rather than silently dropped.
