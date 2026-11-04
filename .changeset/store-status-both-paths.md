---
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': patch
---

`storeAnswerOf` judges a scope store's HTTP answer once: an error envelope at any status, a result only on a 2xx. The direct-binding store path now refuses a result on a non-2xx as `bad_envelope`, as the platform hop already did.
