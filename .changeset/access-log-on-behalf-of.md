---
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane-api': patch
---

The access log names the person a read was made for (`onBehalfOf`) when a team credential carried one; rows written before the column read it as null. The control plane's routes record their registry and scope reads through the request's view, so those rows name the person too.
