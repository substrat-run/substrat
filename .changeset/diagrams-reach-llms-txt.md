---
'@substrat-run/docs': patch
---

The diagrams reach llms.txt, and three of them get redrawn.

A theme component was flattened to `*(Diagram: LayerStack — rendered at the HTML page for
this document.)*` on the grounds that a diagram cannot be flattened honestly. True of a
drawing, and false of ours: `LayerStack` and `RuntimeTopology` render ordinary prose out of
ordinary arrays, so what the pointer dropped was content that already existed — and dropped
it from the one surface agents read.

Each component's content now lives in a sibling `*.content.mts` that exports both the data
the component renders and an `alt()` that renders the markdown twin **from that same data**.
Add an engine to `engines.chips` and it appears in `llms.txt`; there is no second list to
update and no way for the picture and its text to disagree. `toTwin` calls `altFor`, and the
pointer survives only as the fallback for a component with genuinely nothing to flatten.

`lint:llms --check` gains a fourth assertion: a page rendering a component with no registered
`alt()` fails, naming the file to create. Without it the failure is invisible — the page looks
right and everything the diagram says is missing from the twin.

Three drawings change, all in one vocabulary of hand-authored SVG on the existing `--layer-*`
tokens, so they read the same and flip with the theme:

- **`/guide/architecture` §Topology** — the mermaid `flowchart TB` becomes `<ScopeTopology />`.
  Mermaid sized boxes from label length and routed edges with dagre, so the fan-out the picture
  exists to show came out looking accidental.
- **`/guide/architecture` §The hosted runtime** — an SVG now leads the six numbered steps,
  which stay. It draws the one thing a numbered list cannot: the request coming *back*. Step 6
  said the response travels up; now you can see it, and see which layer's code executes in each
  box along the way.
- **`/connectors/` §The seam** — the ASCII block becomes `<ConnectorLoop />`, which draws the
  round trip it could only describe: the scope delegating a delivery out to the worker because
  it has no `fetch` of its own, and the result re-entering through `getConnectorScope`.

Both figures are drawn at 700 units, not the 920 they were designed at — the docs content
column is roughly 665px, and anything wider is either clipped or scaled until the labels are
unreadable.
