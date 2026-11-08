---
'create-substrat': patch
---

The template's worker imports only from `src/provision.ts` (`MODULES`, `OWNER_ROLE_KEY`, `ROLES`, `permissions`, `envSpec`) and `src/routes.ts`, so a vertical built from it needs no edit there beyond naming its join.
