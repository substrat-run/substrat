---
'@substrat-run/demo-ticket0': patch
---

ticket0's README says how the widget is actually embedded

The README described the demo's ports and the substrat.net dogfood, and never the one
thing a reader of this vertical arrives wanting: the tag you put on your own page. So
`widget/widget.js` was documented only by its own header comment — which meant the
answer to "is it a script or a web component?" was a file read rather than a paragraph.

It is a script, and the section now says so and says why: a vanilla IIFE rendering into a
shadow root, no framework, because it runs on somebody else's page and neither side's CSS
should reach the other. Four attributes in a table (`src`, which is also the default API
base, so nothing is baked in at build time; `data-api`, which only the demo needs;
`data-user` and `data-signature`, both or neither).

The two mechanisms behind it get named where a reader will look for them rather than only
in the code that implements them:

- **`data-signature` is `HMAC-SHA256(desk secret, data-user)`, computed by the embedding
  site's server** — Intercom's `user_hash`. Where the secret comes from
  (`POST /api/desk/verification-secret`, shown once, every read of the desk omitting it)
  and what rotating it costs (every signature that site is currently producing) are the
  parts a reader needs before they wire it, not after.
- **The origin allowlist is checked against the `Origin` header, in middleware.** The
  section keeps the reason the check is where it is: withholding
  `access-control-allow-origin` stops a browser *reading* a response and does nothing to
  stop the write behind it, so a refusal that lived beside the handler would be a refusal
  the write had already passed.

Also written down: the session token in `localStorage` and its silent replacement when it
no longer names anything, the polling cadence *as the stopgap `widget.js` already calls it*
(the answer is a WebSocket on the scope's DO, and neither the router nor the DO carries an
`Upgrade` today), and why `scripts/copy-widget.mjs` is a copy rather than an import — the
file is not part of this app's import graph, it is part of somebody else's page.

Documentation only. No code, no schema, no permission changes.
