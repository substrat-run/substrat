---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/connector-fortnox": patch
"@substrat-run/cli": patch
---

A vertical can now declare how a provider's connections land in it: `connections: [{ provider, operation, permission, options? }]` in a module manifest. The declaration is part of the permission registry, so `PERMISSIONS.md` renders it and the permission digest moves with it. On each connector pass the platform grants every live connection of the provider the declared key on each primary, active install, and binds it through the connector's own checked bind. It writes only what is missing or different. Connections created by Connect, a connect link or the dashboard door now land with no operator step.

A connector sweep's row now reports what happened instead of `ok` whenever the sweeper returned: `skipped` when the connection has no binding, and `failed`, naming each scope, when a scope could not be landed in or a declared landing could not be granted or bound.

Fortnox sweeps open the bound company's own connection. A Fortnox binding records the connection's `externalAccountRef`, so a bureau with several companies connected to one vertical no longer fails every company's sweep with "multiple live 'fortnox' connections". The probe and credential summary open the named company too.
