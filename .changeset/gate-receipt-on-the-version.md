---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
---

The push gate's verdict rides the push, so an ungated version is a recorded fact (#955).
`substrat push` already refuses a layer-rule violation before anything is uploaded; what
it found now travels beside the manifest as `origin.gate` — `passed`, `skipped`
(`--skip-lint`), or `none` (no module code found) — and the platform stores it on the
version, where the dashboard flags a `skipped`/`none` push as ungated. A version with no
receipt at all (an older CLI, or a caller that bypassed the CLI and hit the deploy API
directly) reads as ungated too, which is the honest default: the platform receives a
built bundle, never the source the rules are written against, so the CLI's own check is
the only gate there is and a version that cannot show a receipt was not checked by it.
Self-reported like the rest of `origin` — a label and a policy hook, never proof.

Nothing changes for a vertical that pushes clean: the receipt says `passed` and the
dashboard stays quiet.
