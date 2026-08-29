---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

Hostname resolution now filters `status = 'active'` in SQL on the Cloudflare adapter too,
the way the SQLite adapter already did. The router's read (`readRoute`) is separate from
the admin read and carries no scope status, so a suspension re-check cannot creep into the
router; a new contract test covers refusing a name a live scope holds and reclaiming one an
archived scope released.
