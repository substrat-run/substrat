**app/** — built whenever the concept's Screens section names one (only an
explicit "API-only" skips it), in the scaffold, not deferred: Vite + React
served against the API, one view per line of the Screens section, principal
picker in the top bar, typed fetch wrappers over the routes, hash routing with
view state in the URL (`#/…` — refresh must not lose the screen). Keep it in
`app/` with its own package.json; the API proxies or serves it.
