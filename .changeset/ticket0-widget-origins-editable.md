---
'@substrat-run/demo-ticket0': patch
---

fix(ticket0): a desk admin can add and remove widget origins, and what is kept is an origin

The hosted desk on substrat.net answered every widget preflight from `https://substrat.net`
with 403 — "this desk is not embedded on https://substrat.net". The allowlist is desk data
(`ticket0/widget-origins` reads `ticket0_desk_settings.allowed_origins`), the hosted worker
never seeds it, and Settings → Desk rendered the list read-only: no input to add one, a
`Remove` button that was disabled. A hosted desk had no way to embed its own widget anywhere.

- Settings → Desk → Widget origins now has an input + Add (Enter works), a working Remove,
  and an empty-state line saying the widget is refused everywhere until an origin is added.
- `configure-desk` reduces each entry to its `URL.origin` and dedupes. The input schema
  asks for a URL, the browser sends an origin, and `widget-start` compares by string —
  so `https://substrat.net/` or a page path pasted from the address bar used to save
  cleanly and never match. A non-http(s) URL is refused with `validation_failed`.
- Scenario: a page URL admits the page it came from; `mailto:` is refused; the seeded
  desk is restored after.
