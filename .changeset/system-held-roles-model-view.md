---
"@substrat-run/model-view": minor
---

`parsePermissions` reads the system-held roles of a `PERMISSIONS.md` (the `### 2a. System-held roles` table `lint:permissions` writes once a role is declared `holder: 'system'`) into their own list, `systemRoles`, instead of reading them as roles a person can be given along with a role named `Role` from that table's header. `syncConcept` shows them in a table of their own under the roles. A file without the table has no system-held roles and reads as before. `readRolesSection` is that judgement, shared with `substrat plan`'s classifier, and a table under any sub-heading is no longer read as more rows of the section above it.
