---
"@substrat-run/builder": minor
"@substrat-run/builder-workspace": minor
---

`pnpm builder evals` reports time, gate time, steps and tokens per build phase, and a Claude Code run's output tokens are now the pass's own total. A new `app-build` gate builds `app/`, so a generated app that does not compile fails the build instead of passing unseen.
