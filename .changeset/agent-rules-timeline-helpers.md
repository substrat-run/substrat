---
'create-substrat': patch
---

The `_substrat_*` rule now names the helper for the read it allows. A scaffolded project's `AGENTS.md` — and the same page on the docs site — points at `readTimeline` / `readHistory` from `@substrat-run/kernel` instead of leaving "reads are fine" to be answered with a hand-rolled `SELECT`, and says what `readHistory`'s three nullable fields mean, since each `null` there is a fact rather than missing data.
