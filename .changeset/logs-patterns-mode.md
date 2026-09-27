---
'@substrat-run/dashboard': minor
---

Logs has a Patterns mode (#1747): an app's `ctx.log` lines grouped by the template each was written with. Each row shows the template with its placeholders marked, the level most of its lines were written at, a small histogram over the window, the line count and its share. Clicking a pattern opens its lines in the Lines mode, where the pattern is a removable chip. A pattern is exactly the lines one call site wrote. Lines written with `console.log` have no template, and the empty state says so.
