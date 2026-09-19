---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A refused permission check now records which request it happened during, so a denial can be looked at beside everything else that call did.

Events already carried the identifier of the request that produced them. A denial carried none — and a denial produces no event, which is the whole point of it, so it was the one thing a request could do that nothing could tie back to the request. The record named the operation that was attempted, never which attempt, so two refusals a second apart were indistinguishable and "what else was this call doing" stopped at the parts that succeeded.

The identifier now goes onto the denial the same way it goes onto an event: minted by the platform per request and stamped on the refusal as it is written, on both the self-hosted and the hosted store. Nothing is invented where none was supplied — a seeding script, an internal call or an attachment request records none, which reads as unrecorded rather than as a refusal that belonged to nowhere. Refusals already recorded keep that unrecorded value; nothing can decide afterwards which call they came from.

The denial read surfaces carry the new field, so anything already reading a scope's refusals sees it without changing how it asks.

No application code changes to adopt it. It does take a redeploy: the identifier is minted by platform code an app bundles into its own deployment, so an app already running keeps recording nothing until it is rebuilt on this version and pushed.
