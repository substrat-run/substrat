---
'@substrat-run/demo-manyfold-app': minor
---

Multi-scope Manyfold, D3 (UI): a "New site" control in the app.

Admins get a **+ New site** button next to the site switcher (shown when the caller holds
`content:admin`). It takes a name, calls `POST /api/sites` (which runs `manyfold/request-site` —
D1's permission-gated op), then polls `GET /api/sites` until the platform provisions the new site
and it appears in the registry, and switches to it. This completes the self-serve, in-app,
vertical-authorized site-creation flow (multi-scope-manyfold.md M3) end-to-end over the merged
platform-intent path (A→D2 + the periodic sweep C).

The wait is the platform drain. Today that is the ~2-min periodic sweep, so the control shows a
"provisioning — this can take a minute" note while it polls. The low-latency **router kick** (which
turns that into seconds — `POST /api/sites` already tags its response with `x-substrat-platform-request`
for it) is the one remaining piece: it touches the environment router (critical path) and needs a
control-plane service binding + secret it doesn't have today, so it's deferred to its own carefully
reviewed change. Refs #358.
