---
"@substrat-run/builder-workspace": patch
"@substrat-run/builder": patch
---

Worker-safe `/edge` subpath entry for builder-workspace (only worker-provable
modules — LocalWorkspace's node:* stays behind the root entry), nodejs_compat
for the sandbox SDK, and the idempotent provision script with account pinning
and secrets-prefix near-miss detection.
