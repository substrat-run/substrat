---
'@substrat-run/docs': patch
---

The API conventions get a page, and the error model gets an RFC.

Substrat is opinionated about API shape, and until now that opinion was distributed across
`CLAUDE.md`, six architecture documents, and the header comments of the files that
implement it. A builder asking "how should my list endpoint look" had nowhere to be sent.

`/concepts/api-design` is that page. Nine defaults — the operation spine, boundary parsing,
value types, keyset pagination, the error model, the context clock, request idempotency,
additive evolution, and the generated OpenAPI document — each with the shape, the reason,
and an honest status. Three of the nine are designed and unbuilt, and say so with the issue
number rather than reading as though they work.

Writing it turned up one claim in our own docs that was not true. `boundary-lint` does
**not** check that an operation calls the permission it declares; its rules are star
topology, raw data access, network, spine writes, and the extraction escape hatch. What is
actually enforced is narrower: the *declaration* is a compile error to omit
(`permission` or `narrows` with a reason, never both and never neither), and the permission
*surface* is re-emitted by CI so a widened role appears in the diff. The handler's
`assertAllowed` first line is convention plus review. The page says that, because a docs
site that overstates its own mechanisms is worse than one that admits the gap.

Companion RFC in `docs/rfc/error-model.md` (issue #113): RFC 9457 problem+json, a closed
ten-code taxonomy with module-owned `reason` slugs, and a four-phase rollout that keeps
`detail` byte-identical to today's messages — which is what stops the change turning the
contract suite's thirty message assertions red. It also names the part that is genuinely
awkward: errors crossing the ScopeDO RPC boundary are rebuilt as plain `Error`s by our own
adapter code, which is why `instanceof PermissionDenied` is false in production today.
