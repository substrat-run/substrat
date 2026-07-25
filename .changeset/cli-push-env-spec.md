---
'@substrat-run/cli': minor
---

`substrat push` carries a vertical's declared env-spec to the registry. The CLI reads
`substrat.envSpec` from the vertical's `package.json` — the same static, code-free source it
already reads `slug`/`name` from — and includes it in the deploy manifest, so a pushed vertical
gets a Dashboard config form exactly like a builtin.
