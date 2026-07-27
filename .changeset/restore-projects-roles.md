---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

Restores heal their own permission model: `CloudflareScopeHost.projectRolesLocal`
re-applies a vertical's code-defined role definitions to one scope (scope-level
tuples untouched), and `VerticalClient.restoreScope` now carries `tenantId` so a
vertical's `/internal/restore` can invoke it after the import. A dump captured from
a CP-full world carries tuples but an empty roles table — without the repair, every
check denies while /me still names the role.
