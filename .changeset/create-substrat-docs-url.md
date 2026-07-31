---
'create-substrat': patch
---

Point `create-substrat` at the live docs domain and clarify the missing-directory error.

The `DOCS` constant still referenced the old Cloudflare Pages hostname
(`substrat.ahlstrand.es`), so the usage text, the generated README, and the getting-started
link in every scaffolded project pointed at a stale domain. It now uses the canonical
`https://substrat.net`.

Running `npm create substrat` with no target directory previously dumped the usage text and
exited non-zero, which npm surfaces as a bare `npm error code 1` with no hint that an argument
was missing. It now prints an explicit `a target directory is required` message, while
`--help`/`-h` exits 0 as expected.
