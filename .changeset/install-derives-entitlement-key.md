---
'@substrat-run/dashboard': patch
---

Install derives the vertical's own entitlement key when none are declared (#443): a pushed
vertical whose registry row carries no `entitlements` used to resolve to `[]`, which
defeated every `?? [slug]` fallback — the installing tenant held zero entitlements and the
vertical's projected gate failed closed on its very first gated operation. The install spec
(create, retry, resume) and both provision paths now grant the first non-empty declared set
or `[slug]` (the `entitlementKey` convention), before the scope provisions, so the
entitlement delivery that rides provisioning already carries it.
