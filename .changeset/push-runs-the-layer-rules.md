---
'@substrat-run/cli': patch
---

`substrat push` now runs the layer rules before it builds anything, and refuses on a
violation. Until now `boundary-lint` ran only inside this repo's CI and the builder studio,
so a vertical developed anywhere else was built, uploaded and admitted having been checked
by nothing — the ambient-env ban, private tables, the clock rule and the engine-catch rule
were advisory for exactly the code that reaches production. The refusal names file, line and
rule. A project whose module code the linter cannot find gets a note and a normal push, not
a refusal; `--skip-lint` deploys ungated code deliberately and says so in the output.
