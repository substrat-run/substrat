---
'@substrat-run/kernel': minor
'create-substrat': patch
---

`readRoutedNode` fails closed without a secret (#966). When a request carries
`x-substrat-tenant`/`x-substrat-scope` headers and the worker has no `expectedSecret`
configured, it now throws `RouterAssertionError` instead of trusting the unsigned
assertion — a vertical deployed without its `ROUTER_SECRET` refuses routed requests (400)
rather than serving whichever tenant the header named. The new `allowUnsigned` option is
the explicit opt-out for an un-routed local instance behind a dev router; the scaffolded
`worker.ts` sets it from `ALLOW_DEV_NODE` and from nothing else. The no-headers → `null`
path is unchanged, so a standalone deploy and `ALLOW_DEV_NODE` keep working as before.
