---
'@substrat-run/dashboard': patch
---

The Verticals page had no per-vertical detail view — the only entry point into a
vertical's history was the "All N versions" link, which merely expanded the collapsed
list in place. A vertical is a first-class thing (its pushed versions, admission state,
channels, and prod go-live history), so it now has a page of its own.

Add a `#/verticals/<slug>` route rendering a new `VerticalDetail` page: the full version
list (not just the newest three), the same self-serve channel promotion, and the prod
go-live / rollback history that used to be an inline expand on the card. The slug carries
a slash (`acme/helpdesk`), so it's URI-encoded into a single hash segment and decoded on
the way back. Breadcrumbs read `Verticals › <name>`, and a deep link to an unknown slug
shows a not-found (a loading state while the deployments list is still in flight, so it
never flashes 404).

The summary card keeps its newest-three preview; the title and the version-count link now
navigate to the detail page (`View all N versions →` / `View details →`) instead of
toggling local state.
