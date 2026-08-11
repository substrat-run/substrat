---
"@substrat-run/control-plane": patch
---

fix: the deployed control plane was talking to Scrive's TESTBED — set `SCRIVE_BASE_URL` explicitly in both environments

`SCRIVE_BASE_URL` was set nowhere: not in `wrangler.jsonc`, not in the platform secrets. So the
connector fell back to its own default, `https://api-testbed.scrive.com`, in production. A tenant
connecting a real Scrive credential got a 401 from the testbed — and a 401 is exactly what a
mistyped key looks like, so the failure pointed at the customer instead of at the config.

Both environments now state it: production `https://scrive.com` (the API lives under `/api/v2` on
the main host — `api.scrive.com`, which an old comment in `worker.ts` recommended, has no DNS
record at all), TEST `https://api-testbed.scrive.com`. Stated rather than defaulted, because an
unset var here does not mean "unconfigured", it means "silently pointed at the wrong provider".

Requires a control-plane deploy to take effect.
