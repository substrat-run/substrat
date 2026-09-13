---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

Every event in an app's history can now be followed **forwards** as well as backwards: **What did it do?** opens what it set off.

Each step shows which handlers the event reached, whether they finished, and what they raised in turn — expanding as far as the trail goes. Between this and the existing **Why?**, any event in an app can be opened in either direction: what led here, and what followed from here.

Handlers are reported in three states that are deliberately not merged. One that finished, one that failed and will be tried again, and one that failed and has been given up on all look alike in the underlying record — and telling a customer something will retry when it will not is the kind of wrong that gets noticed at the worst moment. The number of attempts and the last error travel with each.

Where an event reached nothing, that reads as "no delivery recorded", and says why it is ambiguous: either nothing handles that kind of event, or the work has not run yet. The record holds arrivals, not their absence, so the two cannot be told apart and the screen does not pretend otherwise.

There are no timings, on purpose. The platform does not record how long an operation took, and a column of plausible-looking numbers would be worse than an honest absence.
