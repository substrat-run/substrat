---
'@substrat-run/cli': patch
---

`substrat push` with neither `substrat.runtimeNeeds` nor a wrangler.jsonc now
refuses with the remedy — a minimal `runtimeNeeds` block and a pointer to the
sandbox-clean worker shape — instead of surfacing readFileSync's ENOENT. The
config resolution is extracted as `resolveWranglerConfig(dir)`.
