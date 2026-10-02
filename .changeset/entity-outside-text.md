---
"@substrat-run/contracts": minor
---

An entity may mark `outsideText` fields: text written by someone outside the module that is not the subject's personal data (a provider's or a remote site's error, a subject line, a raw header). Like `erasable`, such a field is refused in an `emits.payload` at compile time, and it is emitted to `model.json`.
