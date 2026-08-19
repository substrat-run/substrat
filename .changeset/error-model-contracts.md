---
'@substrat-run/contracts': minor
---

The error model, phase 1: a closed taxonomy, `problem+json`, and an API surface that
finally documents how it can fail.

`packages/contracts/src/errors.ts` lands the contracts half of the error-model RFC
(`docs/rfc/error-model.md`, issue #113): ten codes, a status and title per code, declared
per-code extensions, `SubstratError`, and `toProblem` — the one mapper meant to replace
the seven hand-rolled `onError` handlers that currently choose a status by matching on
error message TEXT.

**Nothing throws these yet.** `toProblem` maps an unrecognised throw to `internal`
exactly as today's transports do, so this ships, is reviewable, and changes no behaviour
anywhere. The kernel throwing typed errors, and the ScopeDO RPC hop preserving them, are
phase 2.

Three decisions worth knowing:

- **`internal` never carries `detail`.** The posture predates this module and survives it
  verbatim: an unrecognised throw is one nobody reviewed for what it discloses, and these
  surfaces have cross-tenant reach. A test asserts a secret in a thrown message does not
  reach the body.
- **The body carries a deprecated `error` duplicating `detail`.** Every SPA in the repo
  reads `{ error }`; RFC 9457 permits extension members; so the transports can adopt
  `problem+json` without breaking a single client. It goes away once they are moved.
- **`isSubstratError` duck-types.** `instanceof` is checked first and not trusted alone,
  because the adapter rebuilds an error crossing the ScopeDO boundary as a plain `Error`
  — which is why `instanceof PermissionDenied` is false in production today.

`buildOpenApiDocument` now emits failure responses with bodies. The problem schema and
each failure response live in `components` and are referenced, so a vertical's checked-in
`openapi.json` gains three lines per failure rather than an inlined body per failure per
operation — the artifact is a review document, and its signal-to-noise is a constraint.
The three emitted documents are regenerated in this change.

`precondition_failed` (412) and `rate_limited` (429) are in the taxonomy so that
`If-Match` (#129) and rate limiting (#130) add no vocabulary when they land, but they are
deliberately **not** documented yet: nothing raises them, and documenting a failure that
cannot occur is worse than documenting none. This narrows the RFC's §6 Q1 leaning, on the
reasoning that motivated the question.
