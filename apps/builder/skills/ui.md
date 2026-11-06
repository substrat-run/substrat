**app/** — built whenever the concept's Screens section names one (only an
explicit "API-only" skips it), in the scaffold, not deferred. Start with
`copy_reference` from `portal`, `.` to `app`: a working shell with themes, the
user menu, hash routing and an entity table. Then rewrite `app/src/screens.ts`,
one screen per line of the Screens section, and set the title in `app/index.html`
and the name in `app/package.json`. Every list is a `<sub-entity-table>` over
`pagedRead`; every action goes through `invoke`; every control is a `wa-*`
element. Do not add React or hand-roll a table. Its `build` script is the
`app-build` gate. Keep it in `app/` with its own package.json; the API proxies or
serves it.
