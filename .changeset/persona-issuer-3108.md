---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': patch
'@substrat-run/control-plane': patch
'@substrat-run/builder': patch
---

A clean-room preview created with `seed: true` holds the version's sample world, and anyone on the team signs in to it by picking a persona at the control plane's persona issuer (#3108). The builder studio's Run asks for one. A version that declares no world gets an `unseeded` preview, which `preview create` marks.
