---
"@substrat-run/engine-absence": minor
"@substrat-run/engine-assistant": minor
"@substrat-run/engine-booking": minor
"@substrat-run/engine-invites": minor
"@substrat-run/engine-invoicing": minor
"@substrat-run/engine-metering": minor
"@substrat-run/engine-notifications": minor
"@substrat-run/engine-protocol": minor
"@substrat-run/engine-workorder": minor
"@substrat-run/connector-fortnox": minor
"@substrat-run/connector-planima": minor
"@substrat-run/connector-scrive": minor
"create-substrat": patch
---

Engines and connectors take `@substrat-run/kernel` and `@substrat-run/contracts` as peer dependencies (`>=0.213.0 <1.0.0`) instead of their own `^0.x` copy: the vertical installs the one kernel they run in, and a kernel release no longer republishes every engine. A project scaffolded by `create-substrat` already declares both; the scaffold now pins `contracts` on its own version line.
