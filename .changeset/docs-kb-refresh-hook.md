---
---

A docs deploy now tells the support desk to re-read the documentation. The refresh is a
reusable workflow (`kb-refresh.yml`) called after **both** paths that publish the site —
the docs-only push in `docs.yml` and the docs deploy inside a release, which moves the
version numbers the reference pages print — so `llms-full.txt` being published and the
desk's copy of it moving are one event instead of two, whichever way it shipped. CI-only,
so nothing published changes.
