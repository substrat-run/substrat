---
'@substrat-run/kernel': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contracts': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': patch
---

The router kick drains the scope a platform intent went into, not only the routed one: `onPlatformRequests` reports the scope, `kickFlags` writes it into `x-substrat-platform-request`, and the control plane honours it within the routed scope's tenant and vertical. A vertical-defined connector's binding can be polled on request (`verticalConnectorScopeSync`), so its connect-time sync and "sync now" run instead of answering 501.
