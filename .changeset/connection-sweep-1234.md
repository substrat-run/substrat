---
'@substrat-run/dashboard': patch
---

An app's connections now show when each was last actually used.

A connection can be set up perfectly and never do anything — the credential is valid, the integration is listed, and nothing has passed through it for weeks. That gap was invisible: the only signal was whether a connection existed and whether it still worked, never whether it was earning its keep.

Each connection now shows when it was last used, and the most recent failure if there was one. A connection with nothing recorded is called out, with one important qualification stated in the copy rather than left to be inferred: the usage record is kept for a fixed window and then discarded, so "nothing recorded" means nothing in that window — not that a connection has never been used. Something that runs monthly looks the same as something abandoned, and telling a customer to disconnect a working integration would be a worse failure than staying quiet.

A connection that has expired or been revoked is not also reported as unused. That is the same fact twice, and it points at the wrong fix: the thing to do is reconnect it, not wonder why it is idle.
