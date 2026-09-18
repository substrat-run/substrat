---
---

`pnpm lint:model` now refuses an engine whose `src/index.ts` header does not state whether it is composed **by call** or **by event** — the convention was written down and agreed on by all seven engines, but nothing held the eighth to it (#976).
