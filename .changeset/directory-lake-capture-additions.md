---
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane': patch
---

The directory lake's capture override can add data sets to the default (`+ops_failures,+sweep_runs`) instead of replacing it, so capturing one more data set for its backfill cannot stop a default's capture (K-70); a contract case holds every data set's capture and backfill on both adapters.
