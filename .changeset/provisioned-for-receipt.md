---
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/vertical-host": patch
---

A CP-less deployment now answers "do I serve this scope for this tenant" from an explicit `provisioned_for` receipt that provisioning, reconcile and a restore's repair write, instead of inferring it from role rows. A scope holding a receipt for another tenant is refused whatever role rows it carries. A scope provisioned before the receipt existed keeps the role-row inference until its next projection writes one, and a restore drops the receipt its dump carried. A projection for a tenant other than the receipt's is refused (409 over the wire), the fan-out reports the scopes that refused after the others have converged, and an unarchive through a tenant the scope does not belong to is refused before it writes anything.
