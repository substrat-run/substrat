---
"@substrat-run/control-plane": patch
"@substrat-run/router": patch
"@substrat-run/dashboard": patch
"@substrat-run/docs": patch
---

ci: auto-deploy the platform apps — a changeset release deploys them to prod
(gated on `changesets.published`), and every green push to main deploys to a
shared test env (gated on `TEST_ENV_READY` until the test resources exist).
Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
migration preflight `--env`-aware.
