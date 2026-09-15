---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
---

Events now record which request produced them, so everything one call did can be looked at together.

The record could already say what an event was caused by and which operation raised it. What it could not say was that two events came from the same request — and that is the grouping any trace view is built on. A request that touches four records and sets off three handlers left eleven entries with no way to tell they were one piece of work.

Each request now carries an identifier that goes onto every event it produces, including those its handlers raise while finishing up, and into the record of the request itself. So an event can be traced to the call that made it, and that call to how long it took and how it ended.

There was no existing identifier to reuse: the one the platform stamps on logs is added after the fact and is not visible to running code, and it does not survive the hop to an installed app. Nothing is invented where an identifier was not supplied — a seeding script or an internal call records none, which reads as unrecorded rather than as a request that never happened.

Existing apps pick this up on their own; nothing needs redeploying for events to start carrying it.
