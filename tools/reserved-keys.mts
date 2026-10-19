/**
 * Keys no person may hold — the half of `lint:permissions` that refuses a role granting one.
 *
 * The rule itself lives in `@substrat-run/contracts` (`packages/contracts/src/reserved-keys.ts`),
 * because `buildPermissionRegistry` and so `substrat push`, the push boundary and a scope host's
 * role doors apply the same one (#2430). This file is where the lint reads it from.
 *
 * Which keys are reserved is declared: a module marks one `holder: 'system'` on its manifest's
 * permission declaration, so an engine states it where it declares the key and the reservation
 * reaches every vertical that composes the engine.
 *
 * It reaches the lint through the vertical's `permissions.modules`, the list every other part of
 * `lint:permissions` reads, so that list has to be what the host registers. A scope host given the
 * same `permissions` (the host option of that name) refuses to register a module the list leaves
 * out (#2430), and the template and every checked-in worker pass it. A host built without it is
 * not checked here, but its role doors still read the reservation off the modules it registers.
 */
export { ownerGrantSets, reservedKeyMessage, reservedKeyOffences, reservedKeysOf } from '../packages/contracts/src/reserved-keys.ts';
