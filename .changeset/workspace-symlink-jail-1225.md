---
'@substrat-run/builder-workspace': patch
---

The builder workspace's path boundary now actually stops a symlink leaving it, which its own description already claimed it did.

The boundary rejects absolute paths and anything climbing out with `..`, and said it also caught a link pointing outside. It did not: the check was purely textual and never looked at the filesystem, so a link placed inside the workspace and pointing anywhere on the machine looked like an ordinary file inside it and was read straight through. Confirmed by trying it rather than by reading the code.

In the local mode this was depth rather than a breach — that mode runs commands directly on the machine, so anything the boundary would have stopped was already reachable by other means, and the surrounding notes have always been explicit that it is a mitigation and not a sandbox. It still mattered: a guard that advertises a protection invites the next thing built on it to rely on that protection, and this one was not there.

Reads and writes through an escaping link are now refused, links that stay inside still work, and writing a file that does not exist yet still works — the last of which is most of what the builder does, and the thing a careless version of this fix breaks.
