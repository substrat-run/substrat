---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
---

Every event in an app's history now has a **Why?** beside it, and it answers.

Open the history of any record and follow one of its events backwards: each step names the event that produced it, back to the request or the scheduled run that set the whole thing off. "This invoice exists because that timesheet closed, because the Monday sweep ran." That chain is read from what was recorded at the time, not reconstructed afterwards and not sampled — so it is the same answer every time, for every event, however long ago.

The last line of the answer is the part that matters most, because it says how far the trail actually goes. A chain that reached the operation which started it and a chain that ran out of recorded history look identical otherwise, and presenting the second as the first would let someone conclude that an automatic step began work it only continued. So the ending is always stated: this is where it started, or this is where the record stops, or there is more above this than one read follows, or the trail names something the app no longer holds.

Events recorded before the platform stored causes say exactly that. Nothing guesses at a missing link, and no chain is presented as complete unless it is.
