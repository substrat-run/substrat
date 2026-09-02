---
'@substrat-run/cli': minor
---

`substrat model view` — render `model.json` as a self-contained HTML page (an ER diagram of
the entities and their `parents` edges, a card per entity with the primary key, natural key
and `erasable` fields marked, plus any declared lifecycles) and print its path. Inline CSS
and SVG, no script and no external reference, so it opens from a file path with no server
and no network — which is what makes it usable at the design gate, where approving a
diagram of your own domain beats approving prose about it. It reads the emitted artifact
`lint:model --check` gates, needs no login, and writes to a temp file unless `--out` places
it.
