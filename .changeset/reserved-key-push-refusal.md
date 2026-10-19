---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
---

A key reserved to a system principal (`holder: 'system'` on its declaration) is now refused at push, not only by `lint:permissions` (#2430).

- `substrat push` (and `push --check`) refuses a role a person can hold, or an entity grant shape, that holds a reserved key, and a role declared `holder: 'system'` that holds anything else or nothing. It refuses before anything uploads, in the lint's own words, naming each grant and the module that reserved the key.
- The registry a push ships carries the reservation: a reserved key's row and a system-held role's row say `holder: 'system'`. Both are left out otherwise, so a vertical that reserves nothing ships the registry, and the permission digest, it had. `push --check` prints the marks.
- The platform's push boundary (`pushedPermissionRegistry`) refuses the same, read off those rows. A registry from a CLI that predates the field marks nothing and is refused nothing.
- The rule itself is exported from `@substrat-run/contracts` (`reservedKeysOf`, `reservedKeyOffences`, `reservedKeyMessage`), which `lint:permissions` now reads too.
