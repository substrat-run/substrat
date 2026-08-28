---
'@substrat-run/demo-ticket0': patch
---

A desk admin can add a documentation source, and a read that fails says so on the row

Settings → Knowledge base listed the desk's sources and offered "Re-read", and that was
all: `ticket0/add-kb-source` existed, `desk-admin` held `kb:manage`, and no screen ever
called it. Two more things stood between an admin and a source that actually worked.
"Re-read" called `/kb/sources/:id/ingest`, which records the intent and emits — the fetch
lives on a separate `/refresh` route the hosted worker mounted and nothing ever called, so
on a hosted desk a re-read spun at `ingesting` for good. And nothing anywhere wrote
`status = 'failed'`: a URL that could not be read — the likeliest thing a person types —
spun the same way, with the reason on the dev server's stdout and nowhere else.

- **`ticket0/record-kb-ingest-failure`** (new, `kb:manage`, entity-scoped, emits
  `ticket0.kb-ingest-failed`): the other half of `record-kb-articles`. Marks the source
  `failed` with the reason and leaves `last_ingested_at` alone — it is when the last GOOD
  read happened, which is what the desk wants to know once one fails.
- **`harness/kb-refresh.ts`** — `readSource()` marks, fetches, records the articles or
  the failure, and `mountKbRefresh()` mounts `POST /api/kb/sources/:id/refresh` (502 with
  the reason on a failed read). The worker's inline route is replaced by it, the dev server
  mounts the same one, and its boot-time ingest goes through it too, so the two hosts
  cannot drift and a boot-time failure lands on the row.
- **The screen** gains "Add a source" — label, URL, kind — which adds and reads at once.
  Only `llms.txt` and `Markdown` are offered: `sitemap` is in the model but the fetcher
  does not implement it, and a control that always fails is worse than none. "Re-read"
  now hits `/refresh`. A failed row shows the reason and whether a last good copy exists.
- A network failure names the URL (`could not reach …`) rather than the runtime's bare
  `fetch failed`, since the message is what the row shows.

Additive: the new operation joins `openapi.json`, `api.generated.ts`, `model.json` and
`CONFORMANCE.md` through their gates; no permission key or role changed.
