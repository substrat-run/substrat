---
"@substrat-run/adapter-cloudflare": patch
---

A CP-less deployment now answers "do I serve this scope for this tenant" from an explicit `provisioned_for` receipt that provisioning, reconcile and a restore's repair write, instead of inferring it from role rows. A scope holding a receipt for another tenant is refused whatever role rows it carries. A scope provisioned before the receipt existed keeps the role-row inference until its next projection writes one, and a restore drops the receipt its dump carried.
