---
'@substrat-run/dashboard-web': minor
'@substrat-run/dashboard': minor
---

feat(dashboard): the team lives in the URL — every route is `/<team-slug>/…`

Dashboard paths are now scoped to a team by their first segment
(`app.substrat.net/acme-x1y2z3/overview`), built on the globally-unique slugs the
worker already mints (name + ULID tail, so a slug can never shadow a section name).
The client router pins the active slug once the session resolves and prefixes it
onto every `navigate()` call and sidebar href — call sites keep writing `/apps/<id>`.
Legacy slug-less paths (old bookmarks) redirect onto the pinned team; a deep link
naming ANOTHER team you belong to switches the session before any data loads, so
a shared `/other-team/apps/…` link opens scoped to that team with no wrong-team
flash; an unknown slug is swapped for the pinned team's. The switcher navigates
onto the new team's URL, and creating a team lands on `/` so the fresh load picks
up the new slug. `/invite/…` links stay team-less by design.
