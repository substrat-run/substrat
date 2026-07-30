---
'create-substrat': minor
---

`npm create substrat` now scaffolds a **working reference vertical** in `src/` + `test/`,
not an empty `src/`.

The reference is a minimal bike-repair shop composed on `engine-workorder` and
`engine-invoicing`, green out of the box (`npm test` → 9 passing, `tsc --noEmit` and
`substrat-boundary-lint` clean, verified against the published packages). It demonstrates
every load-bearing pattern in one place — the manifest/migrations/module split, the
permission check as each operation's first line, the **pricing moment** (read the engine's
reported lines → apply the vertical's price list → hand priced lines back to
`completeWorkOrder`), invoicing **by event** (the star topology, zero imports between
engines), the customer-portal **proof walk** (per-entity `ctx.check`), a two-tenant seed
whose second tenant exists to be attacked, and denial assertions pinned to their messages
and paired with open-door controls.

The playbook's Step 4 becomes "reshape the reference" rather than "build from empty": the
agent reads a real, green implementation and renames it into the user's domain, which is
both safer and faster than authoring from scratch. The generated `package.json` gains the
two engine dependencies (`^0.3.27`).
