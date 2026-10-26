---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'create-substrat': patch
---

A vertical declares only entitlement keys inside its own namespace (#2388): its bare slug and the keys the platform publishes for engines; a tenant-provisioner manager (one declaring `provisions`) may also declare plan SKUs that are not another vertical's slug. A push declaring any other key is refused with a 422, and a platform-granted key (`dashboard`, `builder`) is declarable by none. The install and grant paths read a registry row through the same rule, so a vertical pushed earlier grants nothing foreign while its published versions keep loading. `@substrat-run/contracts` exports `bareSlug`, `declarableEntitlementKey`, `grantableEntitlements`, `entitlementNamespaceRefusal`, `ENGINE_ENTITLEMENT_KEYS` and `PLATFORM_ENTITLEMENT_KEYS`. `npm create substrat` now gates the scaffold on its project name, which is the slug it is pushed under, instead of a fixed `bikeshop`.
