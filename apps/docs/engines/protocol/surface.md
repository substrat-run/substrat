# Operations, functions & permissions

An engine has **no endpoints**. It exposes operations (invoked through a scope stub) and
in-scope functions (called by a vertical inside its own transaction). HTTP, where it exists,
is a generated artifact pointed at by the manifest's `api` field.

This engine has a third surface the others don't: it **contributes a guard predicate**.

## Operations

| Operation | Permission | Does |
|---|---|---|
| `protocol/define-template` | `protocol:create` | register a new template version |
| `protocol/list-templates` | `protocol:read` | list registered templates |
| `protocol/instantiate` | `protocol:create` | start an instance on an entity |
| `protocol/fill` | `protocol:fill` | append a response (open checklist instances only) |
| `protocol/bind-document` | `protocol:bind` | bind vertical content `(ref, hash)` to an open document instance |
| `protocol/request-signatures` | `protocol:request-signature` | freeze and send to named parties for external signature |
| `protocol/cancel-signatures` | `protocol:request-signature` | withdraw an outstanding request set and thaw |
| `protocol/record-signature` | `protocol:record-signature` | record a signature a provider reported |
| `protocol/decline-signature` | `protocol:record-signature` | record a refusal or an expiry |
| `protocol/sign` | `protocol:sign` | sign in-app; freezes the instance forever |
| `protocol/countersign` | `protocol:countersign` | add a second signature on frozen content |
| `protocol/void` | `protocol:void` | supersede an instance (never deletes) |
| `protocol/get` | `protocol:read` | one instance with responses and signatures |
| `protocol/list-for-entity` | `protocol:read` | every protocol on an `EntityRef` |

## In-scope functions

The most complete composable surface of any engine here — every operation has a function
behind it:

```ts
import { instantiateProtocol, requireSigned, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
```

| Function | Notes |
|---|---|
| `defineTemplate(ctx, input)` | register a `(key, version)` |
| `listTemplates(ctx)` | |
| `instantiateProtocol(ctx, input)` | binds to any `EntityRef` |
| `fillProtocol(ctx, input)` | append-only; checklist kind only; throws once frozen |
| `bindDocument(ctx, input)` | document kind only; rebindable while open |
| `requestSignatures(ctx, input)` | **async** — freezes content, opens a request per party |
| `recordSignature(ctx, input)` | **async** — an external signatory, at the provider's time |
| `declineSignature(ctx, input)` | a refusal or expiry; does **not** thaw the instance |
| `cancelSignatureRequests(ctx, input)` | withdraws the set and thaws back to `open` |
| `signProtocol(ctx, input)` | **async** — in-app; computes the content hash via Web Crypto |
| `countersignProtocol(ctx, input)` | **async** — recomputes and compares the hash |
| `voidProtocol(ctx, input)` | |
| `getProtocol(ctx, instanceId)` | |
| `listProtocolsForEntity(ctx, entity)` | |
| `protocolContentHash(template, latest, boundHash?)` | **async** — the hash recipe, exported so you can verify independently. Takes no `ctx`: it hashes a template plus the latest responses (or a bound document hash), nothing scope-bound |
| `requireSigned(ctx, entity, templateKey)` | throws unless signed — the completion-guard building block |
| `requireCountersigned(ctx, …)` | the counter-signed equivalent |

There is deliberately **no `requireAllSigned`**. In the request-driven path an instance
reaches `signed` only once every requested party has signed, so "all parties signed" *is*
`requireSigned` — a second predicate would read as though it checked something stronger while
checking the same thing. The multi-party question is answered by the state machine.

None of these check permissions — that is the caller's job.

**What they return is parsed, not asserted.** Every value crossing back out of this engine
goes through the schema the engine publishes in `src/schemas.ts` — `protocolTemplateRow`,
`protocolInstanceRow`, `protocolResponseRow`, `protocolSignatureRow`,
`protocolSignatureRequestRow`, and the composites the operations answer with (`signResult`,
`requestSignaturesResult`, `protocolDetail`, `protocolSummary`) — the same schema the
matching operation points its `output` at. Engine surfaces evolve additively (D-28), but that
rule is held by review; the parse is what makes the failure it prevents *loud*. A vertical
compiled against 0.3 and running against 0.4, whose row shape moved, used to read a field
that had become `null` and render it — now the read throws at the seam. The reads name their
columns for the same reason: the SELECT list is derived from the row schema (`columnsOf`),
where `SELECT *` would publish whatever the physical table happens to hold.

This engine is the sharper case for having the seam at all. A signature attests to a hash
over the stored rows, so a row that quietly changed shape is a row whose hash no longer says
what the signatory was shown — silence there is worse than a throw.
`engines/protocol/src/seam.ts` is one line, `engineSeam('engine-protocol')`; the helpers
themselves live in `@substrat-run/contracts`.

`signProtocol`, `countersignProtocol`, `requestSignatures`, `recordSignature` and
`protocolContentHash` are **async** because Web Crypto is; the rest are synchronous. That `protocolContentHash` is exported at all is the
point of the invariant: the recipe is a contract you can replay, not a black box.

## The guard predicate

```ts
predicates: { 'protocol/all-signed': allSignedPredicate }
```

The engine **contributes** the predicate; a vertical manifest **wires** it. The engine
declares no guard of its own — *what is mandatory when* is vertical policy, and the engine
cannot know another module's operations.

This is the only genuinely config-shaped surface in any engine. Its config is declared in the
**vertical's** manifest, kernel-opaque, and parsed by the predicate that owns it:

```ts
export const allSignedGuardConfig = z.object({
  templateKey: z.string().min(1),   // vertical content: 'tillstandsrapport'
  entityType: z.string().min(1),    // what the protocol hangs on: 'workorder'
  entityIdFrom: z.string().min(1),  // input field holding the id: 'orderId'
  countersigned: z.boolean().default(false),
});
```

`entityIdFrom` is the trick worth stealing: it **late-binds into the vertical's vocabulary**,
so one predicate serves any operation shape without the engine ever knowing the vertical's
words. That's how you parameterise engine behaviour without a config bag — see
[Composing](./composing#configuration).

## Permissions

| Key | Description |
|---|---|
| `protocol:create` | Define protocol templates and start protocol instances on entities |
| `protocol:fill` | Record responses on an open checklist protocol (append-only) |
| `protocol:bind` | Bind vertical-owned document content (ref + hash) to an open document protocol |
| `protocol:request-signature` | Freeze and request signatures from named parties; also cancels a pending set |
| `protocol:record-signature` | Record a signature reported by an external provider |
| `protocol:sign` | Sign in-app — freezes it forever (the technician fills, the arbetsledare signs) |
| `protocol:countersign` | Counter-sign an already-signed protocol — a second signature on the same frozen content |
| `protocol:read` | Read protocol templates, instances, responses, signature requests and signatures |
| `protocol:void` | Void (supersede) a protocol — never deletes |

Nine keys for what looks like one workflow, because the separations are the product:
fill ≠ sign is the arbetsledare rule, sign ≠ countersign is the customer at pickup, and
`void` is a supervisory act.

`protocol:record-signature` is the odd one and deliberately so: it speaks **for an external
provider**, not for a person, and it is held by **no human role in any demo**. A staff signer
must not be able to assert that some customer signed with BankID. When ingress lands
([#96](https://github.com/substrat-run/substrat/issues/96),
[#97](https://github.com/substrat-run/substrat/issues/97)), granting this key is how a
deployment declares what it trusts to speak for a provider — which is why it belongs in the
permission diff rather than in a config file.

## Entitlement

`entitlementKey: 'protocol'`. Checked per invoke, fails closed. A binary SKU gate, not
configuration.
