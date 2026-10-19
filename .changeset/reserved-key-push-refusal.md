---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/console": patch
"@substrat-run/dashboard-web": patch
---

A key reserved to a system principal (`holder: 'system'` on its declaration) is now refused at push, not only by `lint:permissions` (#2430).

- `substrat push` (and `push --check`) refuses before anything uploads, in the lint's own words, naming each grant and the module that reserved the key:
  - a role a person can hold, an entity grant shape, or an owner grant (a module's `ownerGrants`, or the package's `substrat.ownerGrants`) that holds a reserved key;
  - a role declared `holder: 'system'` that holds anything else, or nothing.

  A `substrat.ownerGrants` that is not a list of keys is refused by both, naming the field, rather than read as no owner grant.
- The registry a push ships carries the reservation: a reserved key's row and a system-held role's row say `holder: 'system'`. Both are left out otherwise, so a vertical that reserves nothing ships the registry, and the permission digest, it had. `push --check` prints the marks.
- The platform's push routes refuse the same, read off those rows:
  - `pushedPermissionRegistry` covers roles and shapes;
  - `pushedOwnerGrantProblems` covers the manifest's `ownerGrants`.
  A registry from a CLI that predates the marks carries none and is refused nothing.
- The diff a promote shows (the dashboard's promote dialog, Permissions tab and Deployments ledger, the console, `substrat promote`) itemises two changes it used to leave out:
  - a reservation moving on a key both versions declare (`reservationChanges`);
  - a role moving between a person's and a system principal's (`roleChanges[].holder`).

  A key that arrives already reserved is marked where it is added (`reservedAddedKeys`), and a role held by a system principal whose holder did not move, a new one included, is marked as one (`roleChanges[].systemHeld`), so no reader shows it as a person's role holding a reserved key.
- The rule itself is exported from `@substrat-run/contracts` (`reservedKeysOf`, `reservedKeyOffences`, `reservedKeyMessage`, `ownerGrantSets`, `declaredOwnerGrants`), which `lint:permissions` now reads too.
