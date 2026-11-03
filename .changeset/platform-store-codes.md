---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': patch
---

A scope-store `storeCode` starting with `substrat.` is now the platform's alone: a call the platform refuses arrives as `substrat.refused`, one it cannot serve as `substrat.unavailable`, and an answer outside the envelope as `substrat.bad_envelope` (was `bad_envelope`). A store that answers a `substrat.` code itself arrives as `substrat.bad_envelope`, so a store's answer is never mistaken for the platform's. The contracts package adds `PLATFORM_STORE_CODE` and `isPlatformStoreCode`, and the kernel's `callScopeStore` takes `{ send, through: 'platform' }` for a transport whose answer comes back through the platform's hop.
