---
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

Add a declarative environment surface to the module manifest, carried on the registry.

- **`envVarSpec` / `EnvVarSpec`** and an optional **`envSpec`** block on `moduleManifest`: a
  vertical declares the environment it needs — key, label, description, placeholder,
  `required`, `secret`, `default`, `group` — self-describing so a host or console can render a
  config form and validate required keys before deploy. Additive-only (decision 28).
- **`resolveEnvSpec(spec, raw)`** resolves a declared spec against a raw environment (a Worker
  `env`, `process.env`, …): it reads only the declared keys (so the manifest is the single
  source of what an app consumes), applies each `default`, and reports absent `required` keys
  without throwing.
- **The registry carries a vertical's `envSpec`.** A new `env_spec` column is added
  additively to the vertical registry in both the SQLite and Cloudflare adapters;
  `registerVertical` stores the spec and an otherwise-identical re-registration refreshes it.
  This lets a host/console render a config form for any registered vertical — a bundled
  builtin or a pushed builder vertical — without loading its code.
- **The push flow carries it.** The `deployManifest` accepts an optional `envSpec`, and the
  `/verticals/:slug/deploy` handler passes it through `registerVertical` — so a pushed
  vertical's declared config reaches the registry (and the dashboard form) like a builtin's.
