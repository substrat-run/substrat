---
'create-substrat': patch
---

`npm create substrat` installs the runtime packages at `^0.126.0` again. The previous release scaffolded a project pinned to `^0.124.0` beside an `engine-workorder` that needs `^0.126.0`, so the new project got two copies of the kernel and failed its own typecheck.
