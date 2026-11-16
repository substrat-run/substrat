---
"@substrat-run/builder": patch
---

A CLI push to a GitHub project keeps its submitted source in one snapshot repository per project, each build as branch `builds/<buildId>`, pruned to the newest 20 builds and deleted with the project. The per-build `snapshot-<buildId>` repositories are no longer created; `POST /internal/legacy-snapshots` lists them, and deletes them with `{ "apply": true }` (#2952).
