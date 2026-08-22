# @substrat-run/template-check

Private, and almost entirely gitignored. Only `package.json` and this file are
committed — `src/`, `test/` and the three configs are materialized by
`tools/template-sync.mjs` on every run and must never be edited here.

## Why it exists

`packages/create-substrat/template` is a call site of every engine surface it
imports, and it was the one call site the TypeScript compiler never saw. So a
non-additive engine change could be correct, reviewed, merged and released — and
reach `npm create substrat` broken — with nothing red until after publish. That is
not hypothetical: #811 moved `listOrders(ctx, status?)` to `listOrders(ctx, page)`,
`lint:pins` advanced the template's pins in the same Version-packages PR, and
`create-substrat@0.7.1` shipped a scaffold that failed **all three** of the gates it
ships with. #874 fixed that instance; this package is what makes it the last one.

The template is deliberately **not** a workspace member (#797): its job is to prove
that a project installing from npm, with no workspace links, works. So this package
owns the `workspace:*` links instead, and the template's sources are copied in.
TypeScript resolves modules from the importing file's own directory, so a symlink or
an `include` pointing back at the template would resolve nothing.

## The two questions, and which one runs when

| | packages from | asks | runs |
|---|---|---|---|
| `lint:scaffold` (#797) | the registry | does a real `npm install` produce a working project? | post-release, weekly |
| this | the workspace | does the template's source still match the surface we are about to ship? | every PR |

Being *ahead* of npm is a pass here and a legitimate red there. That is the whole
distinction, and neither check substitutes for the other.

## Running it

Nothing new to remember — the repo-wide sweeps already reach it:

```sh
pnpm -r typecheck            # tsc, both configs (node + worker)
pnpm -r test                 # the template's own nine-step scenario
node tools/boundary-lint.mjs # the layer rules, as a standalone vertical
```

One honest difference from a real scaffold: this builds on the workspace's
TypeScript, while a scaffold pins `^5.6.0`. Compiler-version compatibility is
`lint:scaffold`'s question, against the real installed toolchain. This one is about
the **surface**.
