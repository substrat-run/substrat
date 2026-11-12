---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/dev-issuer': minor
'create-substrat': minor
---

A deployed vertical can hold its sample world in a seeded preview (#3108). `workerDoor({ world })` serves `/internal/seed-world` and `/internal/personas`, which seat the world's personas only in a clean-room preview; `seatWorldWith` and `personaPrincipal` seat them through the vertical's own identity directory, as the same principal on every push. A persona marked `invited` is offered but never seated. The template's sample world moves to `src/world.ts`.
