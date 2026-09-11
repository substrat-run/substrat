---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Declared-vs-observed findings: the platform now knows what an app **promised** to do, and can say where that differs from what it has actually done.

A push carries a new piece of metadata — every event type each module declares it emits or consumes, tagged with the module that declared it. That fact previously existed only inside a module manifest in the bundle, so nothing outside the running code could ask "what is this app supposed to produce". With it, an app's dashboard reports a handful of gaps that no traffic-sampling tool can find, because they are gaps where nothing happened: an event type a module declares and has never recorded, a handler that has never had anything to do, a provider the app is set up to use that nobody has connected, and one that is connected but no longer usable.

Every one of these is a statement about declarations, not a fault, and the wording says so. A provider with no connection is described as work that waits rather than work that fails, because that is what actually happens — connecting it later releases whatever has queued up behind it. Required capabilities the platform binds itself, like an OIDC issuer, are not reported as unconnected providers.

Two cases deliberately report that they cannot answer instead of answering wrongly. An app running a version pushed before this metadata existed says so, rather than appearing to declare nothing at all; and if an app has recorded more distinct event types than can be compared in one pass, the event findings are withheld rather than calling a type dead because it fell off the end of a list.

An app whose modules declare no events at all is a third thing, and it now reads as itself: it declares none, which is a fact, rather than as a version too old to ask. It keeps its provider findings, which never depended on declared events. And where either side of the comparison had to be cut short, the card's counts say so rather than printing a partial number as a total — a findings view may not claim to have checked what it never saw.
