---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

A vertical can mint a shareable provider connect link (connections.md §3.5.4). `requestConnectUrl` serves the person in front of the vertical, who clicks within fifteen minutes. A bookkeeping bureau also has to get each client company's own Fortnox administrator to approve, and that person opens a mailed link days later with no account anywhere.

- `mintConnectLink`, `listConnectLinks` and `revokeConnectLink` (vertical-host) call the new `/internal/connections/connect-links`, `…/list` and `…/revoke` relays, behind the vertical's own `ctx.check` as for `requestConnectUrl`. A link lives 7 days by default and 30 at most. The 15-minute limit on `requestConnectUrl` is unchanged.
- The link is a row the platform holds in the directory, `_substrat_connect_links`, beside the connections. The consent callback spends it before storing the credential, so it connects once. Revoking it stops the URL working. If the store fails, the link is put back so it can be opened again. List and revoke reach only the calling scope's links.
- `HostAdmin` gains `mintConnectLink`, `getConnectLink`, `listConnectLinks`, `revokeConnectLink`, `consumeConnectLink` and `restoreConnectLink`. Both adapters run the kernel's shared statements over the kernel's `CONNECT_LINKS_DDL`, and `connectLinkContractSuite` (contract-tests) holds each adapter to them. Every change to a link is written to the admin log.
- `ConnectStateClaim` (kernel) has an optional `linkId`. A claim with a malformed one fails verification.
- The control-plane API adds tenant routes under `/tenants/:t/connect-links` (list, read, consume, restore, revoke). A tenant credential can reach them.
