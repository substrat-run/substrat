---
'@substrat-run/control-plane-api': minor
---

`createControlPlaneApi` accepts an optional `cliAdvisory: { minVersion?, latestVersion? }` and stamps `x-substrat-cli-min-version` / `x-substrat-cli-latest-version` on every response when configured — the headers the CLI has read since its version advisory shipped, which no server emitted until now (#971). The two header names are exported as `CLI_MIN_VERSION_HEADER` / `CLI_LATEST_VERSION_HEADER`. Unconfigured, nothing changes.
