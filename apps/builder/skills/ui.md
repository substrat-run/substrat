**app/** — built whenever the concept's Screens section names one (only an
explicit "API-only" skips it), in the scaffold, not deferred. `app/` was laid
down from `portal`: a working shell with themes, the user menu, hash routing and
an entity table, so do not copy it again. Rewrite `app/src/screens.ts`,
one screen per line of the Screens section, and set the title in `app/index.html`
and the name in `app/package.json`. Every list is a `<sub-entity-table>` over
`pagedRead`; every action goes through `invoke`; every other read goes through
`loaded` in `app/src/api.ts`, so a refusal shows as one; every control is a `wa-*`
element. A screen offers every action its line in the Screens section names, each as a
visible control: a `wa-button`, a checkbox. A row that opens its record does it as the
starter's does, `row-click @sub-row-click=${…}` to a screen with `nav: false`, and a row
click does nothing else: never tick, delete or revoke on a row click. After an action, call
`reload()` on each table it changed, as the starter's add does: a table keeps what it loaded, so
re-rendering the screen shows the old rows. Do not add React or
hand-roll a table. Its `build` script is the
`app-build` gate. Keep it in `app/` with its own package.json; the API proxies or
serves it.
