---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

Dashboard: real path routing (`/verticals`) instead of hash fragments (`/#/verticals`).

The SPA ran on a hash router, so every route lived under `/#/…` and the per-vertical
detail view was only reachable by hand-editing the fragment. The client now runs on the
History API, so `app.substrat.net/verticals` and `…/verticals/<slug>` are first-class
URLs — bookmarkable, refresh-safe, and shareable — and a vertical's detail view is a
proper page instead of everything piling onto one screen.

- New `lib/router.ts` `navigate()` helper: `history.pushState` + a synthetic `popstate`,
  so programmatic navigation and Back/Forward share one path. `App` re-parses
  `window.location.pathname` from a single `popstate` handler (`parsePath`, replacing
  `parseHash`). Sidebar and inline links keep a real `href` and `preventDefault()` the
  left-click, so middle-click / open-in-new-tab still work.
- No worker changes were needed for deep links: the Workers Assets binding's
  `single-page-application` not-found handling already serves `index.html` for any
  non-`/api` path, and OIDC `returnTo` is already guarded to same-origin paths. The one
  server touch is the GitHub-connect redirect, now `/apps/new` (was `/#/apps/new`).
- A vertical slug carrying a `/` (`acme/helpdesk`) is URI-encoded into a single path
  segment (`%2F`), which the browser and edge preserve, so it never splits across route
  parts. The legacy `/deployments` alias still resolves to Verticals.

Verified end-to-end against the built bundle in a headless browser: `/verticals`,
`/team`, and the encoded-slug detail link `/verticals/acme%2Fhelpdesk` each boot straight
onto the correct page via the SPA fallback.
