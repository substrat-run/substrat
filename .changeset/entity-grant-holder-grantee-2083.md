---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'create-substrat': minor
---

A bootstrap entity-grant shape can declare `holder: 'grantee'` (#2083). It is for a portal-style record that names no principal and can have several people on it, such as a customer or a contact.

- Whoever holds a live key of the shape on an entity of that type counts as given the shape there. The backfill marks those people as holders, so a key the shape gains later reaches them too. A person whose only key there was revoked is not marked.
- The kernel enforces this: from the first reconcile that carries the declaration, `ctx.grant` refuses every key of the shape on that entity type with `permission_denied`. Only `grantEntityShape` / `grantEntityShapeLocal` can mint those keys, and other keys on the same type can still be shared. A reconcile whose registry drops the declaration lifts the refusal.
- A tuple written before that first reconcile can't be told apart. Declaring `'grantee'` therefore marks every current holder of any key of the shape on that type, however they got it. `PERMISSIONS.md` §4 says so in the shape's row.
- The starter template's portal grant is now a bootstrap shape with `holder: 'grantee'`. Its seed gives the shape whole on every boot and reconciles it, so a key you add to `portalPerms` reaches customers who were seeded before you added it.
