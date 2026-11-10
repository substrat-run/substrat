---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': minor
---

An invited person is let in by the address their sign-in provider verified, with no link to click: the worker door finds the open member invite naming that address and binds them to it (`admitByAddress`, both hosts' `exchangeBecomeLinkById`). `workerDoor({ invites })` mounts `POST /api/member-invites` and its withdrawal, which run the vertical's own operation as the caller. A member invite's link now expires after 14 days, and one naming an address is accepted only from a verified holder of that address.
