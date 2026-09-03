---
'@substrat-run/cli': patch
---

The unserved-UI preflight now recognises the pre-#340 inline pattern before it has been
built, and `preview create` accepts `--allow-unserved-ui`.

The exemption looked only for an `assets.generated.*` module under `src/` — build output,
normally gitignored, and written by the very build step this check deliberately precedes. It
therefore found the file on a machine where an earlier build had left one and never on a
fresh checkout, so CI was refused for a UI the push would in fact have served. It now also
accepts source that **imports** the module, which is the half that is committed.

`substrat preview create` called the same `push()` without forwarding `--allow-unserved-ui`,
so the flag the refusal names was accepted and silently dropped — on the path most likely to
meet the check, since previews run per-PR.
