---
'@substrat-run/control-plane': patch
---

The directory's admin log ships to the lake by default wherever the directory lake's stream is bound (K-70); `DIRECTORY_LAKE_CAPTURE` becomes an override. The scheduled pass's log line now says what the directory outbox captured and shipped.
