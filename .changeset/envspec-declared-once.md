---
'@substrat-run/cli': minor
'create-substrat': minor
---

`envSpec` is declared once, in the code (#1206). `substrat push` now reads the vertical's
config surface off the same import it already makes for `permissions`: the entry named by
`substrat.permissions` may re-export the manifest's spec as `envSpec`, and when it does,
that code-side declaration — the copy the worker actually reads at runtime — is what the
push uploads. Before this, push read only package.json `substrat.envSpec`, so a key added
to `src/manifest.ts` alone was a key nobody could ever set: no settings-form field, no
stored value, and the app silently serving the manifest default.

A vertical that has not adopted the export pushes exactly as before (package.json's copy
still ships). One that has adopted it and still carries a *drifted* package.json copy is
refused — with the differing keys named — rather than warned; an identical leftover copy
passes with a note to delete it. `substrat push --check` runs the same refusal and reports
the code-declared keys (in `--json` too), so CI catches the drift before a push does, and
`preview create` goes through the same path. The scaffold template now declares its
settings once, in `src/manifest.ts`, re-exported from `src/provision.ts` — the generated
package.json carries no `envSpec` block.
