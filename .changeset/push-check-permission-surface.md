---
'@substrat-run/cli': minor
---

`substrat push --check` — run the push's permission preflight on its own. It resolves
`package.json` `substrat.permissions`, imports the entry, derives the registry and prints
every key (with the module that declares it and its description), every role, every
entity-grant shape and the digest promotion compares — then stops, before any credential is
resolved and without a network call, so it belongs in a pull-request job. `--json` prints the
same surface as data on a clean stdout, for a CI that diffs it against a checked-in copy.

Every failure exits non-zero with a message naming the pointer: a missing declaration, a
pointer naming a file that has moved, an entry that stopped exporting `permissions`, and — new
diagnostic, on the push path too — an entry that cannot be bundled and imported outside the
vertical's runtime. Verticals gating this in CI can drop their deep import of
`@substrat-run/cli/dist/push.js`, which was never a public surface.
