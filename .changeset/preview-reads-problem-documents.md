---
'@substrat-run/cli': patch
---

`substrat preview` reads a refused response the way every other command does. Its own
error reader was the last one left over from before the shared RFC 9457 reader landed, so
a preview failure printed a slice of raw JSON where `push` and `promote` printed the
sentence and the code. The shared reader also learned the pre-#113 `{ error, issues }`
validation body: a Zod refusal's issues now print as named fields under the message
(`ttlHours: Expected number, received string`) instead of `invalid request` alone, on
every command rather than only on `preview`.
