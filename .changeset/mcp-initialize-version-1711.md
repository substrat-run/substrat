---
'@substrat-run/vertical-host': patch
---

The MCP endpoint no longer refuses `initialize` when the client proposes a protocol revision newer than the ones it speaks. On the handshake the `MCP-Protocol-Version` header is a proposal: the server answers with its own latest revision, and an unauthenticated client now gets the 401 challenge that starts sign-in instead of a 400. Every later request is still refused if it pins a revision the server does not speak.
