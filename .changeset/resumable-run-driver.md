---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Long work can now stop halfway through and carry on from where it stopped, instead of starting again.

The platform already had three ways to move work off a request, and each one assumes the work finishes. An effect that fails is retried whole. A recurring operation fires and must run to the end. A maintenance pass does its round and reports it. None of them fits an import that walks a hundred thousand records in an external system over an hour, where a deploy, an eviction or a single upstream hiccup means starting from nothing.

There is now a fourth kind of work for exactly that. A run is a record kept with the app's own data: what it was asked to do, where it has got to, what it has counted, when it started, and — if it stopped — why. Work inside a run is done in named steps, and a step that has already succeeded is not done a second time, whether the interruption was a failure further along or the machine disappearing mid-way. Between stretches of work the run hands forward a marker of where it reached, so the next stretch resumes there rather than at the beginning.

Asking for a run that is already in flight joins the one already happening and gives back its identity, rather than starting a rival walk over the same source. That is a decision the driver makes rather than a constraint on the record, deliberately: a run whose worker vanished is still an unfinished run and has to be restartable, which a "only ever one of these" rule would refuse.

What may be handed to a run is ids and configuration — the things that survive being passed between machines. Bytes, dates, class instances and functions are refused when the run is started, naming the exact field, the same way an invalid request to an app is refused. A step that runs out of retries ends its own run with the error kept on the record, and never disturbs the other runs beside it.

Both the self-hosted and the hosted store keep the same records and behave identically; the behaviour is pinned by one shared conformance suite that runs against each.

No application code changes to adopt it, and nothing existing behaves differently. Runs only appear where a deployment registers work of this kind and starts one.
