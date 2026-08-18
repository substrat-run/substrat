---
'create-substrat': patch
---

Fix the dependency pins — a scaffolded project could not install.

`index.js` carried one `ENGINES` constant, `^0.3.37`, for every engine. Engines do
not share a version line: `engine-workorder` had moved to 0.4.x and
`engine-invoicing` to 0.6.x, and a caret range on a 0.x version pins the minor. So
`npm create substrat my-app && pnpm install` resolved *nothing* for either engine
and failed at the first command in the getting-started guide.

One pin per engine now, with the reason in a comment, so the next engine minor
breaks one line instead of all of them. `SUBSTRAT` moves to `^0.71.0` and
`BOUNDARY_LINT` to `^0.0.7` at the same time — both were pointing at releases
several months old.

Found while rewriting the getting-started page against what the scaffolder
actually does. A template's pins are the one thing no test in this repo exercises:
CI installs from the workspace, so the published ranges are only ever resolved by
a stranger.
