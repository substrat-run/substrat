---
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/router": patch
"@substrat-run/control-plane": patch
---

Peer-call answers can be read from the routing read model: the directory publishes an answer that dispatches once a router asks for it, and the router reads it memory → KV → the directory under its own `PEER_READ_MODEL` switch, off by default.
