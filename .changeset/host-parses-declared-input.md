---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/engine-booking': minor
'@substrat-run/demo-rally': patch
'@substrat-run/demo-shop': patch
'@substrat-run/demo-meridian': patch
---

The host parses a declared operation input, so no handler has to

`OperationShape.input` described itself as *"the SAME Zod object the handler parses"*. Across the
fleet it mostly was not. Of ~85 declared inputs, 40 were parsed; `demos/rally` declared 32 and
parsed 2; `demos/shop` declared 14 and parsed none. The declaration was true about the *shape* —
the compiler holds `idFrom` and `entityIdFrom` to it — and false about the parsing, which is the
half that refuses a malformed call (#893).

**A lint rule was the other candidate and is strictly weaker.** It can ask only whether *some*
`.parse` appears in a handler body, never whether it is the declared schema, at the boundary,
before the first read of a field. And it cannot be satisfied at all where the schema is declared
inline — `demos/callout`, `demos/handlebar` and `demos/todo` declare 25 inputs as
`input: z.object({…})` with no identifier a handler could name, and the reference implementation
is one of them.

So the host parses instead, from the declaration that already produces the manifest, the routes
and the OpenAPI document:

```ts
export const bookingModule: ModuleRegistration = {
  manifest: bookingManifest,
  operations: OPERATIONS,
  operationInputs: operationInputsOf(bookingOperations),
};
```

`operationInputsOf` derives name → schema; `ModuleRegistration.operationInputs` carries it; both
adapters parse before the guards and the handler, outside the transaction. Every path in is
covered — HTTP, a scenario test, a seed, a schedule — which is why this is not at the HTTP mount:
parsing there alone would have left the demos' own suites exercising the one route the fix did not
cover. `mountOperations` already made this argument for the page trio, in those words, and it is
the argument here.

A schema declared for an operation the module does not bind is refused at registration: a schema
on nothing enforces nothing while reading as coverage.

**Adopted by the four packages #893 named** — `engines/booking`, `demos/rally`, `demos/shop`,
`demos/meridian`. The rest of the fleet is unchanged and still hand-parses or does not;
`inputParseContractSuite` is what makes the guarantee portable once they adopt.

## Three things the change turned up, none of them predicted

**1. A paged read invoked in process was handed `undefined`.** `ImplInput` types a paged
handler's input as `… & PagedInput` with no undefined arm, because the platform supplies the page
*"whether it declared one or not"* — and over HTTP that was already true. In process it was not:
`invoke('booking/list')` with no argument is the ordinary way a test or another operation reads a
list. The empty page is now materialised in the derived schema rather than each paged handler
learning to survive `undefined`. A required filter still fails, against `{}` and with a message
naming the field.

**2. `entityCheckConformanceSuite` read its fixture at collect time.** The extras a case is driven
with were spread in the `describe` body, before `beforeAll`. A fixture entry holding a value that
does not exist yet — rally's spare member, created in `beforeAll` and written into the object the
kit was handed, which is the documented way to supply an id the harness must make first —
captured the empty placeholder instead. Nothing said so: case 1 only asserts "was not denied",
and case 2's permission answer arrived before anything looked at the field. Read per case now.

**3. Two fixtures had never been valid.** `booking/join`'s conformance `partyRef` was 27
characters where the declared `dataSubjectId` wants a 26-character ULID, and `demos/shop`'s
scenario §8 reached an elapsed hold by asking for `holdSeconds: 0` — which the declared input has
always forbidden (`.positive()`), and which is the exact thing the house rule names instead of
`manualClock`. §8 now runs on a clock it advances, the way its own sibling `hold-expiry.test.ts`
already did while criticising it.

All three are the same finding in different clothes: a value nobody parsed was free to be wrong.
