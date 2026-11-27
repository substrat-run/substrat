---
"@substrat-run/model-providers": minor
"@substrat-run/vertical-host": patch
---

A model call through the Workers AI binding now passes AI Gateway (#3320). `bindingGatewayFor(provider, { attribution, env })` gives the binding's `gateway` option: the five attribution keys as metadata, the gateway `CLOUDFLARE_AI_GATEWAY_ID` names (the account's `default` gateway otherwise), and `collectLog: false`, so no prompt or answer is kept. The model host passes it on every binding call, so the call is counted per tenant, scope and vertical as an HTTP call is. A vertical picks it up by upgrading and re-pushing.
