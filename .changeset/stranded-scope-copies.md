---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/vertical-host": patch
---

Track per-script scope copies in a directory ledger before any are written, through confirmed carries, adopts and rebinds; retry fenced cleanup, and drain recorded copies during reap. Coordinate subject redaction across recorded copies before destroying its key. A copy move whose request died is settled by the scheduled sweep once its lease runs out, so it no longer blocks erasure or reap.
