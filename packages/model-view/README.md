# @substrat-run/model-view

Render an emitted Substrat `model.json` — entities, field schemas, parent edges, declared
lifecycles — as **one self-contained HTML page**: inline CSS, inline SVG, no script, no CDN,
no external reference of any kind. It is the pure rendering core shared by `substrat model
view` (the CLI, #756) and the dashboard's Model tab (#1214), which is why it lives apart
from both: no filesystem, no `node:*` imports, no DOM — the same function runs in a Node
CLI, a Cloudflare Worker, and a browser bundle.

It reads the **emitted artifact, never the TypeScript**. `model.json` is the artifact of
record (#697): `lint:model --check` gates it in CI, and everything downstream — this
renderer included — reads it rather than re-deriving from source.

## Using it

```ts
import { parseModel, renderModelHtml } from '@substrat-run/model-view';

// `raw` is a model.json you read yourself — a file, a manifest field, an HTTP body.
const model = parseModel(JSON.parse(raw), 'demos/todo/model.json');
const html = renderModelHtml(model, { source: 'demos/todo/model.json' });
// → a complete HTML document: write it to a file, serve it, or iframe-`srcdoc` it.
```

`parseModel` refuses anything that is not a model — with an error naming the artifact and
the malformed declaration — rather than rendering an empty or broken page. `source` is
display-only (a path in the CLI, a `slug@version` in the dashboard); pass `title` when the
default (the source path's parent directory) is not the right tab title.

## Caveats a user hits first

- **The page is static.** No script means no pan/zoom, no click-to-highlight, and no
  overlay hooks. A surface that needs live overlays (per-entity row counts, #1214's
  long-term shape) renders its own component — `layerDepths` is exported so such a
  component can reuse the layout — rather than post-processing this HTML.
- **The diagram shows declared facts only.** An entity outside `defineEntities` does not
  appear, and a `parents` edge pointing outside the model is drawn as no arrow (the entity
  card still names it). A sparse diagram usually means thin registry adoption, not a bug.
- **Field order is the model's order.** The renderer never sorts; `emitModel` already
  emits deterministically, and re-sorting here would misrepresent the artifact.

## What the tests prove — and don't

The suite proves the rendered page carries every reviewable fact (tables, parent edges,
composite keys, erasable marks, lifecycle edges), escapes hostile names, terminates on a
cyclic `parents` declaration, and references nothing external (no `http(s)://`, no
`<script>`, no `<link>`, no `src=`). It does **not** prove the page is legible for very
large models (wrapping is asserted structurally, not visually), and it does not validate
semantic coherence of the model — `emitModel`/`emitLifecycles` refused an incoherent
declaration at emit time; this package only refuses malformed *shape*.
