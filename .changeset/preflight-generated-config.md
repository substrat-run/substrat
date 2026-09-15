---
'@substrat-run/control-plane': patch
---

Fixes a prod deploy broken by templating the account ids out of the wrangler config.

`preflight-migrations.mjs` reads the wrangler config and then shells out to `wrangler d1 execute` with the package directory as its cwd — so wrangler auto-discovers `wrangler.jsonc`, which since the previous change carries `"database_id": "${CF_D1_AUTH_DB_ID}"`. The placeholder matches no database, and the check failed with `could not read migration state`, a message that says nothing about the actual cause. It ran *before* the generator in the deploy chain, so the resolved config did not exist yet.

The generator now runs first and preflight reads the file it produced, passing it on to wrangler so the subprocess cannot re-discover the template. Callers whose config carries no placeholders — the dashboard — pass nothing and keep auto-discovery.

A missing `--config` is a hard failure rather than a silent skip: the caller asked for that file, and a deploy that checked no migrations because a generated config was absent is exactly the failure this check exists to catch.
