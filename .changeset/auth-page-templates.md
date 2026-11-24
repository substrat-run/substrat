---
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-auth-server-app': minor
---

An install can draw its sign-in screens inside its own HTML page, a Liquid page template written the way Auth0's Universal Login page templates are: `{%- auth0:head -%}` and `{%- auth0:widget -%}` plus the application, branding, language, screen, tenant and signed-in person to print. Set it on the console's Branding page, with a live preview of each screen in both languages, or through `/api/v2/branding/templates/universal-login`. A template that does not render on every screen is refused on save, and one that fails when a page is opened falls back to the built-in page. See `PAGE-TEMPLATES.md`.
