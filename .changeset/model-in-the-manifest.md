---
'@substrat-run/model-view': minor
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
---

The entity model ships with a push, and the dashboard renders it (#1214). A vertical with
a checked-in `model.json` (the artifact `pnpm lint:model` emits, #697) now carries it in
the deploy manifest — metadata beside `envSpec` and `surfaces`, in no digest — and the
dashboard's new Model tab renders the DEPLOYED version's model: the ER diagram, the entity
cards, and the declared lifecycles (#844), for exactly the version the app runs.

The rendering core moved out of the CLI into a new published package,
`@substrat-run/model-view`: the pure `model.json → self-contained HTML` half of
`substrat model view` (#756), with no `node:*` imports, so the CLI, the dashboard worker
and the browser bundle all draw the same page from the same artifact. `substrat model
view` behaves exactly as before. Contracts gains `emittedModel` — the Zod twin of the
`EmittedModel` interface — so the control plane re-parses the model at the trust boundary
instead of trusting the CLI's serialization, and the control plane grows the matching
owner-narrowed read: `GET /verticals/:slug/versions/:id/model`.

A vertical with no `model.json` pushes exactly as before, and versions pushed by an older
CLI stay readable — the tab shows an empty state pointing at the next push.
