---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

An app's screens can now be told when something changed, instead of asking every few seconds.

Every screen that watches for change has had to poll, because nothing on the platform could hold a connection open and push. An app's scope keeps the one truthful record of what happened — every change it makes is written there — and it can now also hand out a subscription to it: a connection stays open, and when a change commits, whoever is watching is told.

What is sent is a notice, not the row. A frame names what changed — the kind of thing, which one, and when — and the screen re-reads it through the same operation it already calls. So nothing arrives that has not been through the app's own declared read, with that read's permission check and its own handling of personal data, and a subscription can never become a second way to get at data that the ordinary way would have refused.

Who is told what is decided per change, per watcher, after the change has committed. An app says which kinds of thing are watchable and which permission it takes to read one, and a change is announced only to watchers who pass that permission **on that particular record** — the same walk a read of it would make, so a record shared with one person and not another is announced the same way. A kind of thing the app has not declared watchable is announced to nobody, which is also what an app that says nothing gets: silence, exactly as before. Permission is re-checked on every frame rather than once when the connection opens, so access taken away while somebody is watching stops the notices with it.

A watcher costs nothing while it is idle — a scope with connections open still sleeps between them — and a change that cannot be announced never affects the change itself: it has already been saved, and the screen's existing periodic refresh remains the floor underneath the notices.

Not every connection can carry one. Where an app is reached through a customer's own domain that is itself proxied, the network in front of us does not carry these connections at all, so the platform declines the subscription rather than opening one that would never deliver — and says so in the reply, so the screen knows it is falling back to asking rather than being told. That is decided per request, from what the connection itself reports, so it follows the customer's own DNS the moment they change it.

Self-hosted apps are unaffected and unchanged: the self-hosted store runs inside the calling process, with nothing that outlives a request to hold a connection open, so it does not offer subscriptions — and asking it for one is refused when the app is compiled, rather than hanging at runtime.

Nothing changes for an app that says nothing: no app is watched until it declares which of its records are watchable, and one that declares none behaves exactly as it did. Taking it up is not automatic either — an app says what is watchable, opens the door on a screen, and has that screen listen — and the last two of those are not in this release. What ships here is the platform side: the subscription, the filter, and the declaration they read.
