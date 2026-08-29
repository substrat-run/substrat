---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/vertical-host": patch
"@substrat-run/demo-ticket0": patch
---

The model runtime is bound only for a vertical that declares it (#1054). `substrat.usesModels` in package.json travels with the version, like `outbound` and `sendsEmail`, and the control plane binds `env.AI` only when the platform allows it AND the version asked — so the capability appears in a manifest diff a human reads at admit, rather than being granted to every pushed script. `ModelHost.status()` now applies exactly `createModel()`'s rule: only a row declaring a binding transport is credential-free, so a direct row's factory no longer reports a keyless provider as configured.
