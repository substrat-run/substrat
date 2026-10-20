---
"@substrat-run/vertical-auth": minor
---

Remove the unused built-in Better Auth email/password provider from IdentityDO. OIDC workers no longer pull Better Auth or Drizzle into their bundles. Authentication continues through the configured OIDC issuer; the per-tenant identity directory, ownership, invites, sites, scope configuration, and OIDC session secret remain intact.

The former doAuthProvider export and IdentityDO HTTP authentication surface are removed. Consumers must use oidcAuthProvider or oidcRpAuthProvider. Existing credential tables are left untouched, but are no longer created or used; the separate auth-server keeps its credential handling.
