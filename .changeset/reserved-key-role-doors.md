---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/engine-test-kit": patch
---

A scope host's person-facing role doors and its raw grant doors refuse a key reserved to a system principal, and its platform role doors refuse a role mixing one with other keys (#2430). The platform doors do not yet tell a person from a host principal: they admit a role made only of reserved keys for any principal. A host can also hold its registered modules to the vertical's declared permission surface.

**Which keys.** The reservations are read off the modules the host registers (`holder: 'system'` on a manifest permission entry), and off the modules its declared `permissions` lists. A key none of them marks is a person's key, so nothing an older engine declared is refused.

**The doors and what each refuses.** Every refusal is `forbidden`.
- **A person's doors** refuse a role carrying a reserved key, even to a caller who holds every key of it. They are `assignScopeRoleBounded`, `changeScopeRoleBounded` (the role moved to) and a membership add. A membership add answers `{ applied: false, reserved }`, which the membership executor records as the refusal. `canAssign` and `ctx.canAssign` give the same answer.
- **A raw grant** of a reserved key to a principal or an org is refused, whoever makes it: `HostAdmin.grant`, `grantToOrg`, `grantEntityShape`, the Cloudflare host's `grantEntityLocal` and `grantEntityShapeLocal`, and `ctx.grant`, including inside `ctx.atomic` and from a system actor.
- **The platform's doors**, `HostAdmin.assignRole` and the Cloudflare host's `assignScopeRole`, refuse a role mixing a reserved key with other keys. They admit a role made only of reserved keys, the shape a role declared `holder: 'system'` has (K-55).

**What the platform's doors cannot tell.** A stored role does not record its holder, and these doors do not know whether the assignee is a person. So a role made only of reserved keys is admitted for any principal. Two roles assigned there can give one principal reserved and person keys together.

**What is never checked.**
- Nothing already held is revoked.
- Not checked yet:
  - a role or grant a host seats or composes itself;
  - a role definition widened after it was assigned;
  - a role or grant conferred on a host that registers no modules.

**Declaring the surface.**
- `SqliteScopeHost` and `CloudflareScopeHost` take a new option, `permissions`. `defineScopeDO` takes it as a third argument, `{ permissions }`.
- The value is the vertical's `definePermissions(...)`. Given, a module its `modules` leaves out is refused at registration (on the ScopeDO, when the class is defined), and what the listed manifests reserve joins what the registered ones do.
- Omitted, nothing is compared.

**New exports.**
- From the kernel: `reservedRoleRefusal`, `reservedGrantRefusal`, `noteReservedKeys` and `assertModuleDeclared`.
- From contract-tests: `reservedRoleContractSuite`, which both adapters run.

**Test kit.** The engine test kit's `as(...)` / `mintPrincipal(...)` gives a principal its reserved keys through a role made only of them, declared `holder: 'system'`, and the rest through a person's role. A test asking for both still gets exactly that set.
