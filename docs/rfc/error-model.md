---
status: proposed
layer: kernel
description: One error model — RFC 9457 problem+json, a closed code taxonomy, typed throws that survive the RPC hop.
---

# The error model — problem+json, a closed taxonomy, and errors that survive the hop

Status: **proposed** (v0.3 — §3 rewritten after measurement, then built as the envelope)

> Answers issue [#113](https://github.com/substrat-run/substrat/issues/113), the first item
> of the [#132](https://github.com/substrat-run/substrat/issues/132) tracking list — and the
> one the rest of that list queues behind, because conflict bodies (#129), replay bodies
> (#116) and limit bodies (#130) are all *this* document's vocabulary spoken by another
> feature. Companion to [api-surface.md](../architecture/api-surface.md) (the OpenAPI
> emit this lands in) and [kernel-design.md](../architecture/kernel-design.md).

## 0. The gap, restated

Substrat has no error model. It has seven copies of one, none of them typed.

Every vertical hand-rolls the same `onError` handler, matching on **error message text** to
choose a status code:

- [`callout/routes.ts:23-31`](../../demos/callout/src/routes.ts#L23-L31)
- [`meridian/server.ts:176-180`](../../demos/meridian/src/server.ts#L176-L180)
- [`manyfold/routes.ts:27-42`](../../demos/manyfold/src/routes.ts#L27-L42)
- plus shop, rally, todo, handlebar — **and the scaffold template**
  ([`create-substrat/template/src/server.ts:49-52`](../../packages/create-substrat/template/src/server.ts#L49-L52)),
  which is what makes this a replicator rather than a fixed-size cleanup.

The control plane does the same thing at greater scale and already wrote its own
successor into a comment ([`control-plane-api/src/errors.ts`](../../packages/control-plane-api/src/errors.ts)):

> It is still text. The durable fix is typed errors on `HostAdmin` — a tagged union the
> adapters throw and this reads.

Three consequences, all live:

1. **The API surface documents no failures.** [`openapi.ts:57-62`](../../packages/contracts/src/openapi.ts#L57-L62)
   emits `400/401/403/404` with a prose description and **no schema**. Every operation
   documents its success shape and is silent about every way it can fail — precisely the
   half a generated SDK, an MCP tool, or a build agent needs most.
2. **`instanceof` does not work.** Manyfold's comment names it: the op error crosses the
   `ScopeDO` RPC boundary and is rebuilt as a plain `Error`, so `instanceof
   PermissionDenied` is false in production and a denial degrades to a `400`. The seam is
   [`scope-do.ts:328-331`](../../packages/adapter-cloudflare/src/scope-do.ts#L328-L331):
   `err.constructor === Error ? err : new Error(err.message)` — the subclass and every own
   property are dropped by our own code.
3. **`500 internal error` is not actionable** — for a human, and much less for an agent
   that could self-heal from `validation_failed on field 'email'`.

## 1. The wire format: RFC 9457, with one extension that earns its place

Errors serialize as `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)):

```json
{
  "type":   "https://substrat.net/errors/permission-denied",
  "title":  "Permission denied",
  "status": 403,
  "detail": "permission denied: customer:manage",
  "code":   "permission_denied",
  "permission": "customer:manage",
  "error":  "permission denied: customer:manage"
}
```

- **`type`** is the canonical identifier and it **resolves** — to the docs page describing
  that failure and what to do about it. An error that documents itself is the whole point
  of choosing a URI over an integer.
- **`code`** is the same identity as a short slug. Yes, this is redundant with `type`, and
  the redundancy is deliberate: `type` is what the RFC standardises on, `code` is what
  people actually `switch` on. Both are generated from **one registry entry**, so they
  cannot diverge — the redundancy is in the wire format, never in the source.
- **`detail`** is today's `err.message`, verbatim. Keeping it verbatim is what lets §5
  land without a flag day.
- **`error`** duplicates `detail` for one deprecation window. Every existing SPA reads
  `{ error }`; RFC 9457 explicitly permits extension members; so phase 3 ships **without
  breaking a single client**. It is removed on a stated date, not "eventually".

Per-code extensions (`permission`, `field`, `errors[]`, `entity`, `retryAfter`) are declared
per entry, not free-form.

## 2. The taxonomy is closed — and small

A tagged union in `@substrat-run/contracts`. Closed, because an open one is a suggestion:

| `code` | Status | Raised when |
|---|---|---|
| `unauthenticated` | 401 | No session or bearer token. |
| `permission_denied` | 403 | `ctx.check` refused. Carries `permission`, and `entity` for per-entity checks. |
| `forbidden` | 403 | Policy refusal that is **not** about the caller's permissions — sandbox violations, `deploy refused:`. Carries `reason`. |
| `not_found` | 404 | The addressed thing does not exist — including K-3's fail-closed case, where it exists under another tenant and must read as absent. |
| `conflict` | 409 | Well-formed, but conflicts with current state: illegal transition, `already taken`, immutable-after-export, `not active`. Carries `reason`. |
| `validation_failed` | 400 | Input did not parse. Carries `errors: [{ path, message }]`, mapped from the Zod issue list. |
| `precondition_failed` | 412 | Reserved for `If-Match` (#129). Declared now, unused, so that feature adds no vocabulary. |
| `rate_limited` | 429 | Reserved for #130. Carries `retryAfter`. |
| `unavailable` | 503 | A deployment fact, not a fault in the request — e.g. `SecretBoxUnconfiguredError`, a host started without a seal key. |
| `internal` | 500 | Everything unmatched. **Generic body, always.** |

Two rules that are not negotiable:

- **`internal` never carries `detail`.** The existing posture is correct and survives
  verbatim: an unrecognised throw is by definition one whose message nobody reviewed for
  what it discloses, and this surface has cross-tenant reach.
- **`reason` is module-owned, `code` is platform-owned.** An engine may not invent a code;
  it may narrow one with a `reason` slug it owns (`conflict` + `reason: "already_exported"`).
  This is the star topology applied to failure: a vertical can branch on the engine's reason
  without importing the engine's types.

## 3. Surviving the RPC hop — measured, and it changed the answer

This is the part that decides whether the whole design is real, because it is where the
current one dies. **v0.1 proposed a sentinel prefix on `message`, and then guessed that
`name` would be a cleaner carrier. Phase 2 measured both against workerd. The measurement
is in `packages/adapter-cloudflare/test/contract.test.ts` and it says:**

> Across the `ScopeDO` boundary, **only `message` survives.** `name` is not a second
> channel: setting it on the rewrapped error does not deliver a `name` on the far side —
> workerd folds it into the message as `"<name>: <message>"` and resets `name` to
> `'Error'`. Own properties do not survive at all.

That kills the `name` carrier outright: adopting it silently rewrites every error message
on the Cloudflare path (`permission denied: perm:use` becomes `PermissionDenied:
permission denied: perm:use`) for every log line, every vertical's `onError`, and every
UI string. It was tried, the test caught it, and it was reverted.

It also weakens the message sentinel, which remains mechanically possible — `message` is
a carrier — but is only *safe* if every reader decodes it before display. There is no
single place to do that: `host.ts` obtains the stub and calls it directly from dozens of
sites, so a sentinel would leak into whatever forgets. Wrapping the stub in a decoding
proxy is conceivable and was not attempted; an RPC stub has delicate property and
disposal semantics, and that is a real change rather than a two-line one.

**So the successor was promoted from contingency to plan, and then built.** Structure
crossing this boundary travels as a **value**, not as a throw: `ScopeDO.invoke` returns
`{ result, platformRequests, failure? }`, where `failure` is a `WireFailure` — name,
message, code, extensions, plain JSON. The coordinator rebuilds an error from it and
throws THAT, so the envelope is the wire's shape and never the API's: every caller above
`host.ts` still writes `try`/`catch` exactly as before.

**It is opt-in per call, and that is what makes it deployable.** The coordinator passes
`failureEnvelope: true`; a ScopeDO instance still running older code ignores an unknown
trailing argument and throws exactly as it always did, which the coordinator still
handles. The reverse skew cannot silently swallow an error either: without the flag the
DO throws. No flag day, and no window where a failure reads as a success.

**What it deliberately does not do.** The rebuilt error is a `SubstratError` wearing the
original `name`, NOT an instance of the class that was thrown — contracts cannot import
the kernel, and reviving arbitrary classes across a wire is a capability nobody should
want. `instanceof PermissionDenied` stays false on this path and always will. That is
the wrong question; `errorCodeOf` is the right one, and every consumer in the repo asks
it that way.

**Still to convert.** `invoke` carries the envelope; the five other throwing RPC methods
(`attachmentAdd`, `attachmentList`, `attachmentAuthorize`, `attachmentRemove`,
`introspectQuery`) still throw across the hop and lose their structure. Same pattern,
mechanical, lower traffic.

## 4. Where it lands

- **`@substrat-run/contracts`** owns the registry, the Zod schema, `SubstratError`, and
  `toProblem(err): Problem` — one function replacing seven `onError` bodies plus
  `mapError`.
- **`openapi.ts`** gives `ERROR_RESPONSES` a body: `content: { 'application/problem+json':
  { schema } }`, generated from the same Zod object that validates it. D-22 cashed in a
  third time — the document cannot drift from the enforcement because they are the same
  object.
- **The scaffold template** adopts it in the same PR as the verticals. Otherwise the
  replicator keeps running and the next generated vertical needs migrating on the day it
  is born.

## 5. Rollout — five phases, no flag day

1. **Contracts.** Registry, schema, `SubstratError`, `toProblem`, OpenAPI wiring. Purely
   additive; nothing throws it yet, nothing breaks.
2. **Kernel + adapters.** `PermissionDenied` becomes a `SubstratError` subclass — same
   name, same message, now with `code`; `SecretBoxUnconfiguredError` likewise.
   `errorCodeOf` reads a code by shape, and `vertical-host`'s classifier consults it
   before its message patterns. **The RPC seam is NOT solved here** — see §3: it needs
   the envelope, which is its own change. Converting the remaining bare `Error` throw
   sites in the adapters is phase 2b, mechanical and message-preserving.
3. **The wire.** Failures cross the ScopeDO boundary as a value (§3), so a code and its
   extensions reach the coordinator intact. `vertical-host`'s classifier reads the code
   before its message patterns.
4. **Transports.** `mapError` and every vertical `onError` read `code` first and **keep the
   regex table as a fallback**, deleting patterns as each throw site is typed. Bodies gain
   the problem shape while retaining `error` (§1), so no client breaks.
5. **Cleanup.** Contract-suite assertions migrate from message text to `code`; the regex
   fallback and the `error` duplicate are deleted.

**The constraint phase 4 exists to respect:** the contract suite asserts on roughly thirty
message patterns (`/already taken/`, `/illegal scope transition/`, `/not active/`, …)
against both adapters. That is a feature — it is why `errors.ts`'s regex table is less
brittle than it looks — and this RFC must not turn it red on wording. Keeping `detail`
verbatim through phases 1–3 is what buys that; phase 4 then migrates the assertions to the
stronger check deliberately, as its own reviewable diff.

## 6. Open questions

1. **Per-operation error narrowing.** Should the model declare which codes a given
   operation can actually return, so `/openapi.json` documents `409` only where a conflict
   is reachable? This wants the same declaration seam as
   [#811](https://github.com/substrat-run/substrat/issues/811). *Leaning: not in v1 — emit
   the full set per operation, narrow once the model layer owns it.*
2. **Do we serve `/errors/{code}`?** The `type` URI is only worth a URI if it resolves.
   *Leaning: yes, generated from the same registry into the docs site — otherwise use plain
   slugs and drop the pretence.*
3. **`conflict` splitting.** Uniqueness conflicts and state-machine conflicts are both 409
   but want different client handling. *Leaning: one code plus `reason` now; splitting later
   is additive, merging later is not.*
