---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": minor
---

A composed engine's own declared schedule now runs on an install that holds the vertical's entitlements and not the engine's. Before, the §4.3 gate asked a schedule for the SKU of the module that owns the operation, so `engine-absence`'s `absence/expire-stale` failed on every standard meridian install. Now an invoke through the system door (`getSystemScope`) of an operation that the same module binds and declares in its `schedules` needs no SKU. Its `system:<moduleId>` grant is the switch, as it already was for permissions. Every request-reachable door still needs the operation's own key, and so does a system-door invoke of any other operation. The kernel exports the rule as `requiredEntitlementFor`, with the `OperationEntitlement` type, and both adapters run it. The contract kit adds `scheduleEntitlementContractSuite` and its `composedEngineMod` / `composerMod` fixtures.
