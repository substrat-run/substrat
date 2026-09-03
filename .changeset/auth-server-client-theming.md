---
'@substrat-run/demo-auth-server': minor
---

Per-client theming for the hosted OIDC pages. The application that sends someone to
`/login`, `/signup` or `/consent` now decides how those screens look: its operator stores a
Clerk-shaped `theme` object (`colorPrimary`, `colorBackground`, `borderRadius`, `logoUrl`,
`title`, …) in the client's existing `metadata` — the dashboard's client editor grows an
Appearance section for the common keys — and the SPA applies it as CSS custom properties,
resolved per `client_id` from the signed authorize query. The public read
(`GET /api/branding`) returns only the key-by-key sanitized theme and answers identically
for unknown, disabled and unthemed clients, so it discloses nothing about the registry.
