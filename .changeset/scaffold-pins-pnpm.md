---
'create-substrat': patch
---

A new project pins the pnpm the platform builds with (`packageManager`). Unpinned, it took whatever pnpm was installed, and pnpm 11 stops on better-sqlite3's ignored build and holds back a release younger than its minimum age.
