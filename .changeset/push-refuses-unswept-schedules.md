---
"@substrat-run/cli": minor
---

`substrat push` (and `push --check`, and `preview create`) now refuses a vertical whose modules declare `schedules` but whose worker exports and binds no `defineScopeSweeperDO` class. A schedule an engine declares counts too. Without a sweeper the deploy succeeds and the schedules never fire on a hosted deploy. The refusal prints the wiring. `--allow-unswept-schedules` pushes anyway for a sweeper wired in a shape the check does not follow.
