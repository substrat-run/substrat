---
'@substrat-run/vertical-auth': minor
'@substrat-run/dev-issuer': minor
---

vertical-auth: `mountSession` (`/session-route`) is `GET /api/me` — `{ principal, display, email }` plus a vertical's own fields, `needs-setup` while the owner seat is unclaimed, or 401 — and reports the login's place. dev-issuer: `DevCaller` carries the issuer's `email`.
