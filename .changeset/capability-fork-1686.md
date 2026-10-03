---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A copy of a scope no longer carries its link shares or runs its pending platform requests. A fork, a snapshot or a preview now starts with no capabilities, and so does a backup of one scope restored onto a different scope. Before, the copy carried the capability rows, so a live link also opened the preview. Platform requests the source had not yet run (an email, a connector delivery, a usage line) arrive in the copy settled as failed with a "not carried" reason, so the platform's drain never runs them a second time from the copy. A backup restored into the scope it came from keeps both its links and its pending requests, and so does moving a scope onto a new version. A restore that does not say which scope the dump came from is treated as a copy. `capabilitiesForLoad` and `settleCopiedIntents` in the kernel are the rules both adapters' loaders apply.
