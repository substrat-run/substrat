---
'@substrat-run/control-plane-api': minor
'@substrat-run/builder': patch
---

`GET /verticals/:slug/builds/:revision` answers the recent version already built from a source revision; the studio's Run binds it instead of building the same commit again.
