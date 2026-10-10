---
'@substrat-run/demo-auth-server': minor
---

People can be moved here from another issuer without a password reset. `POST /api/admin/users/import` (administrators only) takes up to 500 people per call: each keeps the id their old issuer gave them, so relying parties that know them by that `sub` still recognise them. Each person can bring a bcrypt password hash and the upstream identities they signed in with (GitHub, Google, …). Sign-in accepts the imported bcrypt hash until the person next sets a password, which is then stored as scrypt like any other. Re-running an import is safe. An address already held under a different id is reported as a conflict and left untouched. `dryRun: true` reports what would happen without writing anything.
