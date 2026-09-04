# @substrat-run/model-view

Render an emitted [model](/concepts/model) — the `model.json` your vertical checks in — as
**one self-contained HTML page**: the ER diagram, a card per entity with its keys and
erasable fields marked, and the declared [lifecycles](/concepts/lifecycle). Inline CSS,
inline SVG, no script, no CDN, nothing fetched from anywhere.

```sh
pnpm add @substrat-run/model-view
```

It is the pure rendering core behind two surfaces you may already know: `substrat model
view` in the [CLI](/reference/cli), and the dashboard's Model tab, which shows the model of
the version an app actually runs. Both call the same two functions, so the page a builder
approves at the design gate is the page a tenant later sees.

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

There are no `node:*` imports anywhere in the package: the same code runs in a Node CLI, a
Cloudflare Worker, and a browser bundle. That is the reason it exists as its own package
rather than living inside either consumer.

## What it reads

The **emitted artifact, never the TypeScript**. `model.json` is the artifact of record:
`pnpm lint:model --check` gates it in CI, and everything downstream — this renderer
included — reads it rather than re-deriving from source. Rendering the emitted file is
what keeps the view honest about what actually shipped, and correct across any change of
authoring notation.

## Caveats you hit first

- **The page is static.** No script means no pan/zoom, no click-to-highlight, and no
  overlay hooks. A surface that needs live overlays renders its own component —
  `layerDepths` is exported so such a component can reuse the layered layout — rather than
  post-processing this HTML.
- **The diagram shows declared facts only.** An entity outside `defineEntities` does not
  appear, and a `parents` edge pointing outside the model draws no arrow (the entity card
  still names the parent). A sparse diagram usually means thin registry adoption, not a
  renderer bug.
- **Field order is the model's order.** The renderer never sorts; `emitModel` already
  emits deterministically, and re-sorting here would misrepresent the artifact.

## What the tests prove — and don't

The suite proves the rendered page carries every reviewable fact (tables, parent edges,
composite keys, erasable marks, lifecycle edges), escapes hostile names, terminates on a
cyclic `parents` declaration, survives malformed field schemas, and references nothing
external — no `http(s)://`, no `<script>`, no `<link>`, no `src=`. It does **not** validate
semantic coherence of the model: `emitModel` and `emitLifecycles` refused an incoherent
declaration at emit time, and this package only refuses malformed *shape*.
