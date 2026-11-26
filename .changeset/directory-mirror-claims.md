---
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane": patch
---

K-68 (directory split), step 3b part 2: the dual-write also copies the registry's claims — a tenant's id and slug on create, a hostname on bind, released on delete, the slug freed and the id tombstoned on reap — through the intent-first crossing, recorded in the tenant's object beside the row that makes them. Still off unless `DIRECTORY_MIRROR` is set.
