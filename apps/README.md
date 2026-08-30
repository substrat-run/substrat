# apps/ — source-available, not licensed for reuse

Everything under `apps/` is **first-party product code**: the control plane, the router,
the dashboard, the console, the builder, the egress hop, the docs site. It is published here so that
anyone evaluating Substrat can read the surfaces that operate their data — the audit
spine, the permission model, the admin log — rather than take our word for them.

Reading it is the point. Reusing it is not licensed.

These packages carry **no license grant** and are marked `"private": true` (never
published to npm). Default copyright applies: all rights reserved. That is deliberate,
and it is not the open-core pattern — no feature is withheld from the open build to
manufacture a paid tier. The substrate an `apps/` process runs on is fully open and
genuinely exitable:

- `packages/contracts`, `packages/cli`, `packages/create-substrat`,
  `packages/boundary-lint`, `packages/model-emit`, `demos/*` — **Apache-2.0**
- `packages/kernel`, `packages/adapter-sqlite`, `packages/adapter-cloudflare`,
  `packages/control-plane-api`,
  `packages/vertical-host`, `packages/vertical-auth`, `packages/oidc-rp`,
  `packages/dev-issuer`, `packages/psl`, `packages/model-providers`, `engines/*`,
  `connectors/*` — **AGPL-3.0-only + commercial**

What is sold is the *operated* half — certifications, evidence pipeline, incident
response, audited backups — which is not code and cannot be obtained by copying this
directory (master plan §5.7, decision 32).

If you want to run or embed any of this, the commercial license is the route: see
[LICENSING.md](../LICENSING.md).
