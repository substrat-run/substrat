---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane': patch
---

A directory copy cut off part-way no longer makes every later copy fail and reset the control plane's directory. The snapshot it left behind was dropped inside the next copy's own transaction, which doubled that transaction until it failed. It is now dropped in separate steps before the next snapshot is taken.
