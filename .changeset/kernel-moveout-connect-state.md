---
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
---

**Breaking:** the kernel no longer exports the signed connect state (part of #1978).

- `signConnectState`, `verifyConnectState`, `ConnectStateError` and the `ConnectStateClaim` type now live in `@substrat-run/control-plane-api`, beside the connect-URL and connect-link relays that mint it. The dashboard, which verifies it, already depends on that package. Import them from `@substrat-run/control-plane-api` instead.
- `CONNECT_STATE_PURPOSE` is no longer exported. The purpose label and the token format are unchanged, so a state minted before the release still verifies after it.
