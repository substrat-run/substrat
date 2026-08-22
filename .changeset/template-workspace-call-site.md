---
'@substrat-run/boundary-lint': patch
'create-substrat': patch
---

The scaffold template is compiled against the workspace on every PR (#878).

`packages/create-substrat/template` is a call site of every engine surface it imports, and
it was the one call site the TypeScript compiler never saw. A non-additive engine change
could therefore be correct, reviewed, merged and released — and reach `npm create substrat`
broken — with no gate red until after publish. #811 moved `listOrders(ctx, status?)` to
`listOrders(ctx, page)`, `lint:pins` advanced the template's pins in the same
Version-packages PR, and `create-substrat@0.7.1` shipped a scaffold failing **all three**
gates it ships with: 4 of 9 scenario tests, 2 type errors, 1 boundary violation.

`tools/template-sync.mjs` materializes the template into `packages/template-check`, a
private member that owns the `workspace:*` links, so `pnpm -r typecheck`, `pnpm -r test` and
`node tools/boundary-lint.mjs` all reach it — no new command, no new CI step. Verified by
renaming an engine export and watching the template's typecheck go red on the import.

**This does not weaken #797, and does not add a `pull_request` trigger to `scaffold.yml`.**
The two ask different questions and only one of them can run on a PR: `lint:scaffold`
installs from the **registry** and answers "does a real npm install produce a working
project?", which is only honest after a release. This compiles against the **workspace** and
answers "does the template's source still match the surface we are about to ship?" Being
ahead of npm is a pass here and a legitimate red there — #812 put `ctx.now()` in the template
while the pins still said `^0.83.0`. #811 would have gone red in its own PR, beside the
eleven other call sites it fixed.

`create-substrat` changes only in that the generated `tsconfig.json` and `vitest.config.ts`
move to `project-files.js` (added to `files`), so the check compiles the template under
exactly the configs a scaffold gets rather than a second hand-kept copy. The scaffolder's
output is byte-identical; the package stays dependency-free and buildless.

**boundary-lint**: an external engine's ownership scan is narrowed to its shipped `dist`
when it has one — what the function's own doc comment already claimed. Scanning the whole
package directory picks up `CREATE TABLE` in text that is not a table declaration: an
engine's test suite asserting `no CREATE TABLE for '<name>'` registers a phantom table
called `for`, and every consumer with the word `for` in any line is then told it references
a private table. A published install is dist-only so this never fired there; a
workspace-linked one — a monorepo linting its own scaffold template — points at the full
source tree, and it produced six false R5 violations immediately.
