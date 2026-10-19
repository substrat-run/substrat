---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/engine-test-kit": patch
---

A scope host refuses to hand a person a key reserved to a system principal through a role, and can hold its registered modules to the vertical's declared permission surface (#2430).

- The reservations are read off the modules the host registers (`holder: 'system'` on a manifest permission entry). A key no registered module marks is a person's key, so nothing an older engine declared is refused.
- `assignScopeRoleBounded`, `changeScopeRoleBounded` (the role moved to) and a membership add refuse a role carrying a reserved key with `forbidden`, even to a caller who holds every key of it. A membership add answers `{ applied: false, reserved }`, which the membership executor records as the refusal.
- `HostAdmin.assignRole` refuses a role mixing a reserved key with other keys, and admits a role made only of reserved keys, the shape a role declared `holder: 'system'` has (K-55). A stored role does not record its holder, so here the runtime cannot tell an all-reserved role declared for a person from a system-held one.
- Nothing already held is revoked, and a provisioning seat or an owner hand-over is not checked.
- New option `permissions` on `SqliteScopeHost` and `CloudflareScopeHost`, and a third argument `{ permissions }` to `defineScopeDO`: the vertical's `definePermissions(...)` value. Given, a module its `modules` leaves out is refused at registration (on the ScopeDO, when the class is defined). Omitted, nothing is compared.
- Exported from the kernel: `reservedRoleRefusal`, `noteReservedKeys`, `assertModuleDeclared`. contract-tests: `reservedRoleContractSuite`, which both adapters run.
- The engine test kit's `as(...)` / `mintPrincipal(...)` gives a principal its reserved keys through a role made only of them, declared `holder: 'system'`, and the rest through a person's role, so a test asking for both still gets exactly that set.
