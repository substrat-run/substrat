---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
'@substrat-run/console': patch
---

Workers trace rates are a per-app setting (#3358): `HostAdmin.setVerticalTraceSampling` stores an app's rate for its serving script and for its preview scripts (`traceSampling`, `previewTraceSampling` on the registry row), its owner sets them from the dashboard's Settings → Tracing, and each upload declares the higher of the app's rate and the environment's default (`effectiveTraceSampling`; `VERTICAL_PREVIEW_TRACE_SAMPLING` joins `VERTICAL_TRACE_SAMPLING`). The egress report asks about the serving script too, and lists the scripts that recorded no span (`unobserved`, `spansRecorded`), so an untraced app reads as not observed rather than clean.
