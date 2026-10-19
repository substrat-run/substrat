---
"create-substrat": patch
"@substrat-run/demo-handlebar": patch
"@substrat-run/demo-manyfold": patch
"@substrat-run/demo-meridian": patch
"@substrat-run/demo-shop": patch
"@substrat-run/demo-ticket0": patch
"@substrat-run/demo-tock": patch
"@substrat-run/demo-todo": patch
"@substrat-run/dashboard": patch
---

The scaffold template, the demo verticals and the dashboard hand their scope hosts the permission surface `substrat push` reads (`permissions`), so a module registered beside that surface is refused at registration rather than judged by neither lint nor push (#2430). The todo demo's `MODULES` and `ROLES` move into `src/provision.ts` beside it; `src/seed.ts` still exports both.
