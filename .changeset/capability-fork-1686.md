---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A link share no longer opens a copy of its scope. A fork, a snapshot or a preview now starts with no capabilities, and so does a backup of one scope restored onto a different scope. Before, the copy carried the capability rows, so a live link also opened the preview. A backup restored into the scope it came from keeps its links, and so does moving a scope onto a new version. A restore that does not say which scope the dump came from is treated as a copy. `capabilitiesForLoad` in the kernel is the one rule both adapters' loaders apply.
