---
'@substrat-run/control-plane-api': patch
'@substrat-run/cli': patch
---

Make the lineage fork behind a silent config-delivery 501 self-diagnosing

A `substrat push` publishes versions under the slug it derives from the project
(`package.json` `name`, unless `substrat.slug` pins it), while installs/hostnames — and so
a scope's `vertical` — carry the slug the app was installed under. When those diverge,
`resolveVerticalVersion` filters a scope's bound version by the scope's slug and never
finds it, so per-instance config delivery 501s and `substrat versions <slug>` returns
nothing even though installs are serving. Diagnosing that took hours because nothing named
the split.

- **Control plane:** the config-delivery and reconcile 501s now return an actionable body
  that names the bound slug + version and the likely cause — a lineage fork (versions under
  a different slug), no pushed versions, or none promoted — instead of the bare
  "no deployment is bound". Computed only on the miss path.
- **CLI:** `substrat versions <slug>` cross-checks installs (a slug with bound hostnames but
  zero versions prints a fork warning pointing at `package.json` `name` vs `substrat.slug`)
  and distinguishes "unknown slug" from "no versions". `substrat hostnames <slug>` prints the
  reverse warning when a slug has hostnames but no pushed versions.

Diagnostics only — preventing the fork (consistent push/install identity) is tracked
separately.
