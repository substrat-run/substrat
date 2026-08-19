---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
---

The error model, phase 2: the kernel's errors join the taxonomy — and the RPC hop turns
out not to carry them.

`PermissionDenied` and `SecretBoxUnconfiguredError` are now `SubstratError` subclasses,
so a transport can ask what a throw IS instead of knowing which classes exist. Both keep
their exact names and messages: `vertical-host`'s classifier and several verticals match
those strings today, and renaming them would be a behaviour change smuggled into a
refactor. `errorCodeOf` reads a code by shape — the live property first, then the name,
then the legacy class names — and `vertical-host`'s `classifyError` consults it before
falling through to its message patterns.

**The part worth reading.** Phase 2 was written expecting to make the taxonomy survive
the ScopeDO boundary. It does not, and the RFC's §3 has been rewritten because the
measurement contradicts it.

Workers RPC carries a thrown error's **message and nothing else**. `name` is not a second
channel: setting it does not deliver a `name` on the far side — workerd folds it into the
message as `"<name>: <message>"` and resets `name` to `'Error'`. That was implemented,
and the new test caught it: adopting it would have rewritten every error message on the
Cloudflare path, turning `permission denied: perm:use` into `PermissionDenied: permission
denied: perm:use` for every log line, vertical `onError` and UI string. It was reverted.

The measurement is now a test in `adapter-cloudflare`, pinning both halves: that messages
cross verbatim, and that no class, name or code crosses with them. Every other error test
in the repo runs in a single isolate, where the class survives and `instanceof` works —
which is exactly why the production bug (`instanceof PermissionDenied` false on
Cloudflare) stayed invisible for so long. Nothing crossed the hop in a test until now.

So the RFC's contingency is promoted to the plan: structure crossing that boundary has to
travel as a **value** — a discriminated `{ ok, error }` envelope on `ScopeDO.invoke` —
not as a throw. That is its own change and its own review.

What holds today: in-process, the real class arrives and the full taxonomy works — the
SQLite adapter, and any handler in the same isolate as its scope. On Cloudflare a
transport still classifies by message, exactly as before: no better, and no worse.
