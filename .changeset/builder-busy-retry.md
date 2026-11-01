---
'@substrat-run/cli': patch
---

`substrat push` and `preview create` wait out a busy platform builder: a submit refused with `409 project operation already in progress` is retried with backoff for about eight minutes before the push fails.
