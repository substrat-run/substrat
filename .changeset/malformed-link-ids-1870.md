---
'@substrat-run/demo-tock': patch
'@substrat-run/demo-ticket0': patch
---

A malformed id is refused where the input is parsed, naming the field, rather than by `ctx.link` inside the handler (#1870). In tock, every operation that names a source now holds `sourceKey` to the same lower-kebab pattern `tock/declare-source` uses for `key`. In ticket0, `turnId` on `record-answer`, `record-assistant-failure` and a reply's optional turn must be non-empty with no whitespace.
