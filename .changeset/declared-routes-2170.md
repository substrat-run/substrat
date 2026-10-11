---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
'@substrat-run/model-emit': minor
'@substrat-run/dashboard': patch
---

A declared HTTP surface for routes whose handlers are host code rather than operations (#2170). `defineRoutes` in `@substrat-run/contracts` declares each route's method, path, input and output in the shape an operation uses, with the same compile-time check that every `{var}` in a path names an input field, and `RouteImpl<typeof routes, Ctx>` is the handler map it requires: a route with no handler, a handler with no route, or a return the declared output would not accept is a compile error. `mountRoutes` in `@substrat-run/vertical-host` mounts the set under a base path that may carry parameters of its own. It resolves a per-request context first, so a caller with no session is refused before their input is read, then types the query string by the declared shape, refuses an input the declaration does not accept with a 400, and parses the handler's answer on the way out, so the response carries exactly the declared fields and a handler answering outside them is a 500 naming the route. `@substrat-run/model-emit`'s client config no longer requires an `entities` bag, so a route set with nothing stored of its own can have its browser client generated.

The dashboard's findings routes are the first on it. They now live at `/api/teams/{teamId}/findings…` and answer for the team their URL names, not the team in the `sb_team` cookie. The cookie is shared by every tab, so a tab showing one team could read another team's findings after a second tab switched. A team the caller is not in is a 404 rather than their own team.
