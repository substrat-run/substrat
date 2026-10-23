---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': patch
---

The reserved-key rule now holds where a host defines or seats a role itself (#2447).

- **Defining a role is judged.** `HostAdmin.defineRole` on both adapters, and the role set the Cloudflare host's `provisionScopeLocal` and `projectRolesLocal` project into a scope, throw `forbidden` before anything is written when a person's role (holder omitted or `person`) would hold a key a module reserves to a system principal, or a system-held role would hold a key a module declares for a person. So a role assigned through a door can no longer be widened afterwards. A definition that narrows a role is never refused.
- **The owner's seat is a person's.** `provisionScopeLocal` refuses an `ownerRoleKey` whose role carries a reserved key or is declared `holder: 'system'`. The owner hand-over (`/internal/owner-transfer`) asks the new optional `scopeRoleRefusal(scopeId, roleKey, 'person')` before the owner record moves, and seats through `assignScopeRole(…, 'person')`. `assignScopeRole` keeps the platform's door by default.
- **Every person's door refuses a role stored `holder: 'system'`**, from the stored holder alone, so a host that registers none of the modules still keeps a system-held role from a person.
- **A host that registers no modules** counts every key one of the tenant's system-held roles holds as reserved when a role is defined.
- **A key a host knows nothing about is admitted, deliberately.** A host judges only the modules it registers or lists and the tenant's system-held roles; push judges the whole surface. A key reserved only through a schedule's `permissions`, which no system-held role holds, is not caught on a host that does not register its module (#2446).
- **Nothing is revoked.** A refusal writes nothing, so a seat that already holds a key reserved after it was seated keeps working, and a directory fan-out of a stored definition is projected as it is, never judged again.

New kernel exports: `reservedRoleDefinitionRefusal`, `reservedRoleSetRefusal`, `noteDeclaredKeys`, and the `HostReservations` and `RoleShape` types. `pnpm lint:role-seat-paths` (new, in CI) refuses a host path that seats or defines a role without asking the rule. No migration and no persisted shape change. Grants a host seats itself (an install's owner grants, on a host that does not register the vertical's modules) are not covered yet; push refuses a reserved key there.
