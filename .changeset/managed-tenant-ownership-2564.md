---
'@substrat-run/control-plane-api': minor
---

A manager vertical's `provision-tenant` and `set-entitlements` intents act only on a tenant its own tenant provisioned (#2564, #412 invariant 2).

- **The check.** The tenant the payload names must carry the manager's tenant as `provisionedByTenant`. `provision-tenant` checks right after its idempotent create: a new id is created and stamped as before, and a retry of the manager's own tenant passes. An existing tenant stamped by anyone else stops before any grant, scope or instance write. `set-entitlements` checks before it reads the scope.
- **The refusal** is `failed`, attributed `permission_denied` to the platform, with one fixed sentence that names no tenant: `the payload's tenant was not provisioned by this vertical's tenant`. For `set-entitlements` the answer is the same for a foreign tenant and a missing one. For `provision-tenant` a free id is created, and an existing tenant the manager does not own is refused.
- **Behaviour change.** A tenant with no stamp is refused too: one created through the console, or one a manager provisioned before the stamp was recorded (#503). A manager that re-entitles or retries such a tenant now settles that intent `failed`. Staff still manage those tenants from the console, and every tenant a manager provisions from now on is stamped and stays its own.
