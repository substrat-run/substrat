---
'@substrat-run/control-plane-api': patch
---

Unmapped 5xx from the control plane are now logged server-side, so a `substrat push` that
fails with a bare `500 {"error":"internal error"}` is diagnosable without reproducing it.

`mapError` deliberately returns a GENERIC body for any throw whose message it does not
recognise (an unreviewed message on a cross-tenant surface must disclose nothing). Until now
nothing recorded WHAT threw either, so an unmapped failure was opaque from both sides. The
concrete case that surfaced this: a single registry row with malformed `env_spec`/`install_spec`
JSON makes `mapVertical`'s `JSON.parse` throw a `SyntaxError` (not a `ZodError`, so it skips the
400 branch) — and because `ownerOf` → `listVerticals` maps every row on the pre-upload owner
check, that one bad row 500s *every* builder deploy with no detail.

`onError` now emits `control-plane.unhandled { method, path, detail, stack }` for any 5xx before
returning the generic body. The client response is unchanged (still generic — nothing is
disclosed); the worker tail now names the cause. Mapped 4xx are honest refusals and stay unlogged.
