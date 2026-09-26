---
"@substrat-run/control-plane-api": patch
---

A tenant running a listed vertical another tenant published can read that vertical's versions, its channels and each version's registry, schedules, flow, model and assets again, so the app page shows the version it runs. Since the dashboard's credential became tenant-narrowed, these reads answered 404 to every tenant but the publisher. Ownership still decides who may push, promote or delete; a private vertical stays owner-only, and the migration SQL and prod history reads stay owner-only.
