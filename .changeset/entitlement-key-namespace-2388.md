---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

A vertical declares only entitlement keys inside its own namespace (#2388): its bare slug, the keys the platform publishes for engines, and the slugs of the verticals it `provisions`. A push declaring any other key is refused with a 422, and a platform-granted key (`dashboard`, `builder`) is declarable by none. The install and grant paths read a registry row through the same rule, so a vertical pushed earlier grants nothing foreign while its published versions keep loading. `@substrat-run/contracts` exports `declarableEntitlementKey`, `grantableEntitlements`, `entitlementNamespaceRefusal`, `ENGINE_ENTITLEMENT_KEYS` and `PLATFORM_ENTITLEMENT_KEYS`.
