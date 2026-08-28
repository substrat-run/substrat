---
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/demo-ticket0': minor
---

The client half of a request, normalised once. `@substrat-run/contracts` gains `ClientContext` — the browser, OS and device kind parsed out of the `User-Agent` (`parseUserAgent`), the preferred language, and a geo (country, region, city, timezone, continent) — plus `clientContextOf(headers, geo?)` to build one from the headers every host has. `@substrat-run/adapter-cloudflare` gains `cloudflareClientContext(request)` / `cloudflareGeo(cf)`, the one place `request.cf` is read: Cloudflare's `T1`/`XX` country sentinels become null, the region is the name rather than the code, and latitude, longitude and postal code are not carried. No IP address in either.

ticket0 stores it: `ticket0/widget-start` takes an optional `client`, the widget surface supplies it from the request (the worker via the Cloudflare adapter, the dev server from headers alone), `ticket0_widget_sessions` grows eleven nullable columns for it, and a new staff read `ticket0/widget-session` (`GET /conversations/{id}/widget-session`, `conversation:read`) returns the latest session minus its token hash. The inbox rail shows it as "Safari 17 on iOS · Stockholm, Sweden · 03:12 their time".
