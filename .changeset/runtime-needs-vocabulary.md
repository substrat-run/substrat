---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
---

Builders keep the substrate vocabulary (#190 part B, D-38): a vertical declares what it
needs from the runtime in Substrat terms — `substrat.runtimeNeeds` in package.json
(`entry`, `needsNodeCompat`, an optional pre-bundle `build` command, and its own
`stores`: binding → durable state class) — and never authors `wrangler.jsonc`. At push
time the CLI derives the wrangler config (`wranglerConfigFor`), feeds it to the bundler
via `--config` (written next to the vertical, removed after the build), and assembles
the deploy manifest from the same derived object, so declaration and bundle cannot
drift. The compatibility date is the platform's `RUNTIME_BASELINE` (new in contracts) —
a builder states needs, never substrate config.

The vocabulary is complete at four fields *because* the §4 sandbox contract is strict:
it refuses everything except a vertical's own stores, so own-stores + node-compat + a
build command is the whole of what a builder may legitimately say. Datastores beyond
own stores are deliberately absent — those are platform-provisioned, never
bundle-declared. A hand-authored `wrangler.jsonc` remains the expert/legacy path and is
ignored (with a note) when `runtimeNeeds` is present.

Honest limit, unchanged from the issue: this neutralizes the *declaration*, not the
*toolchain* — wrangler still bundles in the builder's CI.
