---
'@substrat-run/dashboard': patch
---

The Apps overview no longer flashes the wrong screen while the first `listApps()` is in
flight: the list shows a skeleton (same geometry as the loaded page — title row, toolbar,
3-column card grid — so nothing jumps when data lands) instead of "Create your first
app", and a deep link to an app shows the skeleton instead of a flashed "app could not
be found". In the dev preview, `?loading=1` pins the skeleton (like `?onboarding=1`).
