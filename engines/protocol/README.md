# @substrat-run/engine-protocol

Protocol engine for [Substrat](https://github.com/substrat-run/substrat) —
checklists/protocols (self-inspection, condition reports, inspection records) **and signed
documents** (avtal, reports) with the **freeze → immutable** invariant: versioned templates,
append-only responses, a verifiable content hash, and counter-signatures on frozen content.

The engine owns only the invariants. Template *content* — which protocols exist and
what they contain — is 100% vertical-owned, and an instance binds to any `EntityRef`
(a work order today, anything tomorrow). Content comes in two kinds: a `checklist` of
sections and items, or an opaque `document` whose bytes live in the vertical and whose hash
is all the engine holds.

## What it owns

1. **Freeze freezes** — any write to a frozen instance's content fails. Freezing happens at
   an in-app signature, or at dispatch when a document goes out for external signature.
2. **Content hash** — SHA-256 over template content plus the frozen content, verifiable
   against replayed state. One recipe per content kind.
3. **Counter-sign** — a second signature on the *same* frozen content; the hash is
   recomputed and must match.
4. **Append-only responses** — an edit is a new row; history is audit material.
5. **Version-pinned templates** — an instance pins `(key, version)` at instantiation forever.
6. **Void, not delete** — a protocol is superseded, never mutated or removed.
7. **Signatures name a signatory** — a principal, or an **external person with no account**
   (BankID via Scrive), recorded at the provider's timestamp with an evidence reference.

## Install

```sh
pnpm add @substrat-run/engine-protocol
```

```ts
import { instantiateProtocol, PROTOCOL_PERM, protocolModule } from '@substrat-run/engine-protocol';

host.registerModule(protocolModule);

host.defineOperation('acme/start-inspection', async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return instantiateProtocol(ctx, {
    templateKey: 'condition-report',
    entity: input.bike, // any EntityRef — the vertical owns the vocabulary
  });
});
```

`requireSigned(ctx, entity, templateKey)` is the completion-guard building block: a vertical
can refuse to close its own entity until the protocol on it is signed. The engine also
contributes a `protocol/all-signed` guard predicate, so the same rule can be **declared** in a
vertical's manifest instead — where dropping it shows up in a reviewable diff.

## Documentation

**https://substrat.net/engines** — the domain model and invariants, the
signature/evidence model, the full operation and permission surface, event contracts, and how
to compose or extend it.

The docs site is the single source of truth; this README deliberately doesn't restate it.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/contracts`](https://npmjs.com/package/@substrat-run/contracts) — the
  Zod shapes (`EntityRef`, permission keys) this engine builds on

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
