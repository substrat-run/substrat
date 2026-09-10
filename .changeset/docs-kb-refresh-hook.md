---
---

A docs deploy now tells the support desk to re-read the documentation. `docs.yml` gained a `refresh-kb` job that calls ticket0's refresh hook after `cf:deploy`, so `llms-full.txt` being published and the desk's copy of it moving are one event instead of two. CI-only, so nothing published changes.
