---
---

`pnpm secrets:platform` now runs `scripts/secrets.mjs push`, which finishes a rotation by re-putting `PLATFORM_SECRET`/`ROUTER_SECRET` on every deployed vertical. Root operator scripts only — no published package changed.
