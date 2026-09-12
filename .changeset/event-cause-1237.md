---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

An event now records *why* it exists, so the trail from a record back to whatever set it off can actually be followed.

The audit spine already recorded a great deal about every event: who raised it, what authority they held, which invocation it came from, which deployed version was running. None of that is cause. An event raised by a consumer reacting to another event runs on behalf of no invocation at all, so the single most useful question — "this invoice exists; what started that?" — ran out of trail at the first automatic step. The answer existed only in the moment, and was never written down.

Events raised while another is being handled now carry the id of the event being handled. Following a chain backwards is therefore reading recorded fact, not reconstruction: each step names the one before it, all the way back to the request or the scheduled run that began it.

Two things this deliberately does not do. It records nothing where there is no cause — an event raised directly by an operation has none, and says so, rather than pointing at whatever happened most recently. And it invents nothing for events already stored: those keep an empty cause, which honestly means unrecorded, because nothing can go back and decide what a past reaction was reacting to.

Existing apps pick the change up on their own; nothing needs redeploying for the record to start being kept.
