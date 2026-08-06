---
"@substrat-run/contracts": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/cli": minor
---

feat(deploy): native static assets for dispatched verticals (#340)

A vertical can now declare `runtimeNeeds.assets` — a directory of built files plus how the
runtime should route paths against it — and the platform uploads those files to Cloudflare's
own asset store through the three-step `assets-upload-session`. They are served from the edge
without invoking the worker, and versioned atomically with the code.

This replaces inlining the whole SPA into the worker bundle as base64, a workaround justified
by "WfP dispatch has no static-assets path" that has been stale since Workers for Platforms
grew that endpoint. The cost it removes is concrete: ~+33 % encoding overhead counted against
the script-size limit (Meridian's and Manyfold's inlined SPAs are ~3.9 MB of generated source
each), the whole UI re-parsed on every cold start, and a worker invocation for every image.

Assets are **not a binding** — they are a top-level upload path — so they can neither be
allowed nor refused by the §4 binding allowlist. D-44 records the separate decision: the bytes
are admitted because they carry no reach (inert, public, no code and no credential), while
their **content-address is verified** — the asset store dedups by hash across the whole
dispatch namespace, so the control plane re-derives every hash from the received bytes and
refuses a mismatch rather than letting one push decide what another vertical's identical-hash
asset serves. An `assets.binding` (programmatic `env.ASSETS`) is refused at push time rather
than dropped silently, since a worker shipped with an undefined `env.ASSETS` looks deployed
and 500s on first request.

The file manifest is retained with the rest of the deploy manifest, which is what lets a
**promote** re-attach a version's assets onto the stable serving script from content addresses
alone — the archive script gives back the modules (#286), dedup gives back the assets. A
re-serve that finds the runtime has dropped bytes it cannot supply refuses and says to push
again, instead of serving a half-broken page.

The dashboard gains a per-version Assets panel (path, type, size, content hash) over the
manifest it already persisted.
