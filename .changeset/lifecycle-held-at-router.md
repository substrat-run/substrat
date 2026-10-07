---
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

A vertical can declare where its scope lifecycle is held: `"lifecycle": "router"` in package.json's `substrat` block. A vertical built on `@substrat-run/vertical-host` leaves it out and keeps receiving each scope's lifecycle at `/internal/lifecycle`. A deployment that serves its own `/internal/*` surface and does no work a request did not start declares `router`: the router's refusal of a held scope's requests is then the whole hold, and the platform delivers that vertical's scopes no lifecycle and does not ask them for a tenant record.

`substrat push` carries the field in the deploy manifest (`lifecycleHold` in contracts), the control plane stores it on the vertical's registry row beside `sendsEmail` and refreshes it on every push, and the lifecycle delivery's targets leave those scopes out. The auth-server declares it. Before this, every lifecycle delivery to it answered 501, and since the heal began asking every served scope for its tenant record, each pass wrote an ops failure for each of its scopes.
