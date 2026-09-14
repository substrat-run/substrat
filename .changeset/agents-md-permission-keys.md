---
"create-substrat": patch
---

The scaffolded `AGENTS.md` now says that the permission array handed to `defineOperations` is the same `keys` array `src/provision.ts` hands `definePermissions`, which throws at module load when the two disagree.
