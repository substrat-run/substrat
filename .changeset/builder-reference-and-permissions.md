---
"@substrat-run/builder": minor
"@substrat-run/builder-generator": minor
"@substrat-run/builder-workspace": minor
---

Give the builder read-only reference verticals (the create-substrat template and the todo demo) through new `read_reference` and `list_reference` tools, so a build copies working host, seed and sharing code instead of guessing the API. A generated vertical now gets its permission review: the turn renders and commits `PERMISSIONS.md`, and the permissions gate is red once `src/module.ts` exists without a `substrat.permissions` entry. Engines resolve in the model phase, before scaffold. `pnpm builder evals --model claude-code:<model>` runs the sweep on a local Claude Code login and keeps a transcript per fixture.
