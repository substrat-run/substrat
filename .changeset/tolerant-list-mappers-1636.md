---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane': patch
---

One malformed event or denial row no longer hides a whole list, or stops the work queued behind it.

A row whose JSON would not parse used to throw out of every list it appeared in. That covered an
entity's history and timeline, the walks that explain why something happened, the denial log and
its summary. Worse, it covered the event deliveries themselves, where one bad event halted every
event of its type behind it on every pass. Module code cannot write such a row, but a restore
replays a dump's rows verbatim, so a dump from another world or one edited by hand was enough.

**The reads return it, and say so.** A history, timeline, cause-walk, invocation, denial-log or
denial-summary row that does not decode now comes back beside all the others. It carries a new
optional `decodeError` naming every column that failed, and those fields come back empty: the
actor as `{ system: 'undecodable' }`, a JSON field as `null`. That is what tells an unreadable
payload from an erased one. Every value still satisfies the published schema. A row whose own id,
type or time is corrupt has no honest empty value and is still refused, as before.

A denial whose permission key is malformed is listed, not refused. That row can come from a
module that cast a bad key into a permission check, not only from a dump, and the log is where
you go to find out why. Its permission reads as `undecodable:permission`, and `decodeError` quotes
the key it actually checked. A healthy row carries no `decodeError` at all, so a clean list reads
exactly as it did.

**The work skips it, and keeps going.** An event that does not decode is dead-lettered for each
consumer and executor it was due for, with the columns that failed as the error. Its handlers are
never called with it, and the events behind it are delivered. An executor gives up on such an event
on the first attempt, since decoding the same stored text again cannot succeed. The Tier-2 drain
steps over the row too. It is never shipped in a guessed-at form, because the lake cannot take a
row back, and it is never stamped as drained, because it never left. The events behind it still
ship. The sweep reports the skipped event ids on every pass, and `readHistory` still returns the
event with its `decodeError`. That event is missing from the lake until the row is repaired.
