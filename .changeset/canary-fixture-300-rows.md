---
'@substrat-run/contracts': patch
'@substrat-run/cli': patch
---

A store driver's canary fixture may hold up to 300 rows (`STORE_CANARY_FIXTURE_MAX_ROWS`, was 200), so it can carry a real graph repository: 240 foundation rows and a first write. The canary moves a fixture a row a page each way, so 300 rows is the 300-page store move one request is allowed (D-69).
