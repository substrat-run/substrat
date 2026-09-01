---
'@substrat-run/cli': patch
---

`substrat.usesModels` reaches the push again, so a vertical that declares it gets `env.AI`.

The declaration was read from package.json, typed on the push options, sent by `push()`
and honoured by the control plane — but `cli.ts` never passed it from the meta into
either call site (`push`, `preview create`). So the upload always carried nothing, every
version's manifest recorded nothing, and the control plane's binding injection — which
requires the version to have ASKED — never fired for any vertical, on any push, from
#1072 until now. Nothing was red, because every link in the chain was correct on its own.

The visible symptom was a hosted ticket0 desk answering `offline/extractive` with
Settings → Assistant reporting a missing `CLOUDFLARE_AI_API_TOKEN` — accurate, since with
no binding the row falls back to its HTTP transport and the platform holds no credential
there by design.

A vertical already pushed needs a re-push to pick the binding up: `usesModels` is
versioned with the code, like `outbound`.
