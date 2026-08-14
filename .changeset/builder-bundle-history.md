---
"@substrat-run/builder": patch
---

R2 ops corrections: app-level ULID-keyed bundle history replaces the
nonexistent R2 object versioning (restore reads newest, legacy single-key
still readable, prune keeps 10); provision script prefers a narrow
BUILDER_CF_API_TOKEN and verifies it against R2 instead of guessing.
