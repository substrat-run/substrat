---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/cli': patch
---

The vertical host can now record which of an operation's declared output fields each response actually carried, the observed half of field coverage. It is off by default and nothing turns it on yet, so a request costs and returns exactly what it did before. When the platform arms it, each mounted operation's response is checked against the field names its `output` declares: top-level fields only, the first entry of a list or paged read, at most 200 names. The result is written to the invocation record and its log line as `outputFields: { present, absent }`. Only declared field names are recorded. A value never is, and neither is a response key the declaration does not name.
