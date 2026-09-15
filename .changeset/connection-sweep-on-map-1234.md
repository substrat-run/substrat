---
'@substrat-run/dashboard': patch
---

The flow map now shows whether a connection is actually doing anything, not just whether it is connected.

A connection that works and carries nothing looked identical on the map to one carrying the whole app. That fact arrived recently but only as a list underneath; the map — the thing you look at to answer "is this wired and is it running" in one glance — still showed only whether the credential was good.

A connected provider that nothing has passed through in the retained window is now drawn the same way as a declared event that has never happened: present, wired, and with nothing recorded through it. The tooltip states the window, because older activity is not kept and something used monthly looks the same as something abandoned.

Where a provider holds more than one connection — one per external account — the map draws it once and answers for all of them together. It calls the provider unused only when every live account is known to be idle: one account still carrying traffic keeps it plain, and one account whose record could not be read withholds the claim rather than guessing at it.

Two states it refuses to collapse into that. A connection whose usage record could not be read says exactly that, rather than appearing unused — those are different answers and only one is about the connection. And a connection that has expired or been revoked is not also marked unused: that is one fact twice, and the fix is to reconnect it.

The map and the list underneath are now worked out once and shown twice, so they cannot disagree about what has been used.
