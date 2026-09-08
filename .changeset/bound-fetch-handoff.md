---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/dashboard": patch
"@substrat-run/control-plane": patch
---

Connecting Fortnox from the dashboard works on the hosted platform. Every consent
round ended in "the exchange with Fortnox failed" while the same round passed
locally: the callback handed the connector the bare global `fetch`, the connector
calls it as a method, and the Workers runtime refuses that (`Illegal invocation`)
before the code exchange is ever sent — Node's fetch does not, which is why nothing
local saw it.

The kernel now exports `globalFetch`, the runtime's fetch as a `FetchLike` — an arrow
over the global, so the receiver is never in play, and the one place the structural
cast lives. Every host default (`options.fetch ?? globalFetch` in both adapters) and every
connector handoff (the control plane's probes
and sweep, the dashboard's consent callback) uses it, and a new `lint:bound-fetch`
gate refuses the bare global handed on in any spelling, since no suite can reproduce
the refusal. The custom-hostname provisioner keeps its DOM-typed `FetchFn` — a real
`fetch` is not assignable to `FetchLike` under strict TypeScript, so an injected
DOM-typed fetch must not need a cast there — and its default is the bound global, which
is that type with no conversion.
