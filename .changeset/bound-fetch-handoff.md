---
"@substrat-run/dashboard": patch
"@substrat-run/control-plane": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/adapter-cloudflare": patch
---

Connecting Fortnox from the dashboard works on the hosted platform. Every consent
round ended in "the exchange with Fortnox failed" while the same round passed
locally: the callback handed the connector the bare global `fetch`, the connector
calls it as a method, and the Workers runtime refuses that (`Illegal invocation`)
before the code exchange is ever sent — Node's fetch does not, which is why nothing
local saw it. The global is now handed on bound (`globalThis.fetch.bind(globalThis)`)
there and at every other handoff — the control plane's connector probes and sweep,
the custom-hostname provisioner's default fetch, the sweeper wire-up example — and a
new `lint:bound-fetch` gate refuses a bare handoff, since no suite can reproduce the
refusal.
