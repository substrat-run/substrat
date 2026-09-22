---
'@substrat-run/contracts': minor
'@substrat-run/vertical-auth': minor
---

A vertical can tell its identity pool who is a member, so a login's "Your places" list at a team auth server stays in step with the app.

`@substrat-run/vertical-auth` adds `placesReporter`, built from an instance's delivered identity, and three calls on top of it:
- `observePlace` reports what a resolve just established. Call it after `/api/me` resolves a signed-in subject: bound means present, unbound means absent. It goes once per login per isolate, and again after an hour.
- `unbindMember` removes a member's binding and reports the place gone.
- `reportScopeMembers` sends the whole set bound in a scope. Run it from your provision hook, which the platform's reconcile re-runs, and a report that went missing is repaired. A scope with more than 10,000 bindings is refused and logged rather than half-sent.

Reports are best-effort and never throw. They go only to an issuer that publishes `/.well-known/substrat-places`, so an external issuer (Supabase, Auth0, …) is never sent one.

`IdentityDO` gains `unbind(scopeId, sub)` and `subjectsOf(scopeId, limit)`. `unbind` is the directory's first removal: it takes the binding away and never re-opens the owner seat.

`@substrat-run/contracts` exports the shared vocabulary:
- `place`, the exact entry: tenant, scope, hostname, name.
- `placeRegistration` / `placeRegistrations` and `PLACES_CONFIG_PREFIX`, which is how the platform registers a team's apps at an issuer.
- `placeReport` and `MAX_PLACE_MEMBERS`, what a vertical sends.
- `PLACES_DISCOVERY_PATH` / `placesDiscovery`.
