---
'@substrat-run/demo-auth-server': minor
---

People can be moved here from another issuer without a password reset. `POST /api/admin/users/import` (administrators only) writes up to 500 people per call, and each call commits completely or not at all: each keeps the id their old issuer gave them, so relying parties that know them by that `sub` still recognise them. Each person can bring a bcrypt password hash and the upstream identities they signed in with (GitHub, Google, …). Sign-in accepts the imported bcrypt hash until the person next sets a password, which is then stored as scrypt like any other. Re-running an import is safe. An address already held under a different id is reported as a conflict and left untouched. `dryRun: true` checks up to 10,000 people in one call without writing anything, so duplicates far apart in a file are caught. Imported bcrypt hashes must have a cost between 4 and 12.

On the **Users** screen, **Import users** takes a dropped CSV or JSON file. It always runs a dry run first, showing new, merged, unchanged and conflicting people, and writes nothing until you press **Import**.
