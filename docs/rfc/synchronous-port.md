---
status: proposed
layer: kernel
description: "Can an operation wait on an outside service whose answer decides whether it commits? A regulated cash register needs a control code before a sale is registered (#3289). Reads the regulation's text, weighs an OperationContext port against reserve-then-record and against a connector, and recommends reserve-then-record with no new kernel verb. K-62 records it as proposed."
---

# RFC: an outside answer that decides a commit — the synchronous port of #3289

**Status: proposed.** [K-62](../decisions/K-062-an-operation-does-not-await-an-outside-call-inside-its-transaction.md)
records the recommendation as proposed. Nothing is built, and nothing in this document changes code.
**Answers:** [#3289](https://github.com/substrat-run/substrat/issues/3289). **Reads against:**
[platform-intents.md](../architecture/platform-intents.md) (which turns down a synchronous outbound
call from a vertical to the platform), [sub-transactions.md](../architecture/sub-transactions.md)
(`ctx.atomic`), [K-6](../decisions/K-006-strict-per-scope-serialization-structured-clone-stub-boundar.md)
(strict per-scope serialization), [D-46](../decisions/D-046-a-hosted-vertical-s-outbound-egress-is-a-declared-per-versio.md)
(declared egress), [D-64](../decisions/D-064-a-vertical-may-define-its-own-connector-and-it-runs-in-the-vertical-s-worker.md)
and [D-73](../decisions/D-073-a-connector-is-its-own-deployable-unit-with-one-call-contract.md)
(the connector call contract).

## 1. The need, from the regulation's own text

#3289 asks for a kernel-owned request/response port, `await ctx.call(port, request)`, so that a
cash register engine can get a control code from a certified control unit inside the operation that
registers a sale. The issue states the rule as "the control code must be obtained **inside** the
operation that commits the sale … so that either all of them commit with the code or none of them
do". This section checks that against the text, because the design follows from what the text
requires, and that is narrower than the issue's wording.

### 1.1 What the text says

Quoted from Skatteverket's published text of
[SKVFS 2014:9](https://www.skatteverket.se/download/18.3aa8c78a1466c5845874ba/1708608280801/SKVFS2014-09.pdf)
(*Skatteverkets föreskrifter om krav på kassaregister*, decided 9 June 2014). Line breaks and the
PDF's hyphenation are removed. The English is a gloss, not a translation.

| Provision | Text | Gloss |
|---|---|---|
| 4 kap. 9 § | "Ett kassaregister med kontrollenhet ska enbart kunna registrera försäljningsbelopp om ansluten kontrollenhet är i funktion och genererar en kontrollkod som kassaregistret tar emot." | A register with a control unit may register a sale amount only when the connected unit works and produces a control code that the register receives. |
| 4 kap. 9 § | "Ett kassaregister med kontrollsystem ska enbart kunna registrera försäljningsbelopp om det har en fungerande kommunikation med dess buffringsprogram." | A register with a control **system** may register a sale amount only when it can talk to that system's buffering program. |
| 4 kap. 9 § | "De uppgifter som ett kassaregister skickar till eller tar emot från en kontrollenhet eller ett buffringsprogram ska registreras i kassaregistret." | What the register sends to or receives from the unit (or the buffering program) must be registered in the register. |
| 4 kap. 10 § | "I ett kassaregister ska för varje registreringsenhet försäljning och annan löpande användning registreras i pappersform (kontrollremsa) eller i elektronisk form (journalminne)." | Every registration unit records its sales and other ongoing use in a journal. |
| 6 kap. 1 § | "Ett kassaregister får inte ha en funktion som möjliggör att en användare kan ta bort, förändra eller lägga till uppgifter i redan gjorda registreringar." | Registrations already made can't be deleted, changed or added to. |
| 6 kap. 2 § | "Ett kassaregister får inte vara så konstruerat att det är möjligt att registrera försäljningsbelopp utan att kassaregistret samtidigt skriver ut ett kassakvitto i pappersform eller tar fram och skickar ett elektroniskt kassakvitto." | A sale amount can't be registered without a receipt being produced at the same time. |
| 7 kap. 1 § d | "löpnummer för kassakvitto ur en obruten stigande nummerserie" | A receipt carries a number from an unbroken, ascending series. |
| 7 kap. 2 § s, 3 § t | "antal oavslutade försäljningar och belopp" | The X and Z daily reports count the sales that were not completed, and their amount. |

Two definitions place the series. A *registreringsenhet* is "en enhet inom ett kassaregistersystem
som kan slutföra en försäljning genom att beordra att ett kassakvitto skrivs ut … eller tas fram i
elektronisk form" (2 kap. 18 §), and 4 kap. 7 § has each one reported to Skatteverket as a separate
register. A receipt number series therefore belongs to one registration unit (one till), not to a
shop or a tenant.

### 1.2 What the text does not say

- **Nothing about transactions.** The rule is an ordering and a recording rule: no sale amount is
  registered without a received code (4:9), and every exchange is recorded (4:9, third sentence).
  "Inside the operation that commits the sale" is one way to get that ordering. It is not the
  requirement.
- **No voided receipt.** The text defines copies, training, return and pro-forma receipts, but no
  cancelled or voided *kassakvitto*. What it does provide for is a sale that never completed: the
  daily reports count *oavslutade försäljningar* and their amount (7:2 s, 7:3 t). A sale that got no
  code is that kind of sale. It is not a receipt, and on this reading it should not use up a receipt
  number (7:1 d). §4.4 depends on this reading, and §6 Q2 asks the owner to confirm it.
- **The cloud unit's category.** 4:9 has two regimes. With a *kontrollenhet* (SKVFS 2009:2) the
  register waits for a code per receipt. With a *kontrollsystem* (since SKVFS 2020:10, defined by
  SKVFS 2020:9) the register waits only for its local buffering program. The issue describes the
  first regime ("request → control code"). Neither SKVFS 2009:2 nor 2020:9 was read for this RFC.
- **The amended wording of chapters 4–7.** SKVFS 2021:17 amends 2014:9, and Skatteverket says
  registers must meet it from 1 January 2027. Its definition changes could be read from FAR Online's
  consolidated text: for example, 2 kap. 17 § ("registrering") is repealed, and 2 kap. 15 § now
  points to 39 kap. 7 § skatteförfarandelagen. The amended text of chapters 4 to 7 could not be read
  from here. The quotes in §1.1 are the 2014 text. §6 Q1 asks for them to be checked against the
  wording in force on the date the register ships.

### 1.3 What "atomic" has to mean

No primitive can commit our rows and the control unit's own record together. That would be an
atomic commit across two parties that share no transaction, which is the two-generals problem. The
in-transaction port of #3289 doesn't escape it either (§3.1). So "atomic" can only mean the
properties below, and each option is judged against them:

- **A1. No sale without a code.** A receipt row, its number, the counters (grand totals) and the
  sale's journal entry commit **together**, in one transaction, and only with a control code
  received for that receipt's data (4:9 first sentence, 6:2).
- **A2. Every exchange is journaled, including one that failed.** The request is in the journal
  before it leaves (write-ahead). The answer is journaled when it arrives, even if it arrives late,
  and so is the fact that none arrived (4:9 third sentence, 4:10).
- **A3. The receipt series has no gap.** A number reaches a receipt only when its sale commits. An
  attempt that ends without a code is journaled as an uncompleted sale and leaves the series where
  it was (7:1 d, 7:2 s, 7:3 t).
- **A4. Nothing in the journal is edited.** An outcome is a new entry, never an update to an earlier
  one (6:1). This is the engine rule "append-only entries" applied to this engine.
- **Not achievable by any option:** the control unit's state and ours agreeing at every instant. A
  timeout, or a crash after the request leaves, always leaves a window where the unit may have
  answered and we don't know. The best any design can do is make that window **durable and
  visible**: a committed row saying "request N sent, outcome unknown", which the next step has to
  resolve. Options differ on exactly this.

## 2. What the hosts do today

- **The Durable Object.** `ScopeDO.invoke` runs the guards and the handler inside
  `storage.transaction(async () => …)` (`packages/adapter-cloudflare/src/scope-do.ts`). The #770
  probes verified that its rollback survives an `await`, but the `await` probed was not an
  outbound call, and the probe was not kept. Cloudflare documents two relevant gates. **Output
  gates** "hold outgoing network messages (responses, fetch requests) until pending storage writes
  complete", and awaiting a `fetch()` reopens the **input gate** ([Rules of Durable
  Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).
  The docs don't say what happens to a `fetch` issued while an async `transaction()` holds
  uncommitted writes: whether the request waits for a commit that is itself waiting for the
  response, or whether it leaves at once. This repo has never probed it.
- **Serialization.** Both hosts queue every operation on a scope behind the previous one (K-6:
  `OperationQueue` in the DO, `ScopeActor` in `adapter-sqlite`), and the SQLite host holds
  `BEGIN IMMEDIATE` across the handler's awaits. Whatever an operation awaits, **every other
  operation on the scope waits too**: every other till in the shop, and every read.
- **Egress.** R3 keeps `fetch` out of module code. Host code may call out. A call from the
  vertical's worker passes D-46's egress worker and its declared `outbound` hosts. A call made from
  inside the scope DO does not: "Cloudflare outbound workers do not intercept
  Durable-Object-originated subrequests" (D-46). It is observed (D-58), never refused.
- **Credentials.** No door hands a vertical's own request path a tenant's connection credential. A
  connector gets one only when the platform calls in (`probe`, `bind`, `sweep`, `dispatch` in
  [vertical-connectors.md](../architecture/vertical-connectors.md)), or when the control plane opens
  it for a first-party connector. This gap is the same for every option below (§6 Q3).
- **Every outbound path in the kernel runs after commit**: the outbox (K-4), platform intents, and
  connector dispatch. platform-intents.md's non-goal ("not general synchronous RPC") is about a
  vertical calling **up to the platform**, and its reason is the sandbox. This RFC is about a call
  **out to a third party**. The two answers can differ, and §3 argues them separately.

## 3. The options

### 3.1 (a) A declared port in `OperationContext`

The module declares a port: a name, the provider, its host (in the vertical's D-46 `outbound`), a
time budget and a request/response schema. The host performs the call, takes the credential from the
connection store, and returns the request/response pair to the module. Two shapes are possible, and
they behave differently.

**(a1) The call inside the open transaction**, the literal ask:
`const res = await ctx.call(port, req)`, which throws on failure so that nothing commits.

- *Crash or eviction after the request left:* the transaction is gone and nothing durable says that
  number N was sent. The next sale reuses N, and the unit may now hold two different requests for N.
  This breaks **A2**, and the window is invisible.
- *Timeout:* the operation throws and rolls back, **including the journal row of the request that
  already left**. The regulation requires that row (4:9 third sentence), so this breaks **A2**, and
  breaks it by design. The only fix is a journal write that survives the rollback. That means the
  kernel holding a regulated journal outside the engine's transaction, which the three-layer rule
  forbids (the kernel owns no domain entities). It would also split the register's journal, which
  SKVFS 2021:16 exports as one XML file.
- *Retry:* an idempotency key (#116) replays only a **committed** result, and nothing committed. So a
  client retry sends a second request with the same number.
- *DO semantics:* undocumented and unprobed (§2). At best the output gate adds a delay; at worst the
  call deadlocks until it times out. Even if it works, the scope's queue is held for the whole round
  trip, so every till in the shop waits on every other till's control unit.
- *Egress:* the call leaves from the scope DO, which D-46 does not police.
- *Regulation for an unanswered request:* met (no receipt), but the exchange record is lost, so the
  rollback breaks the very requirement the port was meant to serve.
- *Three-layer rule and R3:* R3 stays for `fetch`, but the kernel now runs third-party I/O in the
  middle of a transaction, for every vertical.

(a1) is worse than the alternatives on A2, the regulatory property it exists for. It is not
recommended in any form.

**(a2) The host stages the call between two transactions of one invocation.** An operation declares
`prepare` (transaction 1: number, attempt, request journal row) and `complete` (transaction 2:
receipt, counters, response journal row, or an abandon). The host commits `prepare`, releases the
scope's queue, makes the call within the budget, then runs `complete`. After a crash, the host finds
a prepared exchange with no completion and runs `complete` with `outcome: 'unknown'`.

- *Correctness:* the same as (b) below. Transaction 1 is the durable write-ahead and transaction 2
  records or abandons the attempt.
- *Cost:* a second invocation lifecycle in both adapters' invoke path, which is the most complex
  code in the repo. Idempotency (#116) would span two commits. The K-34 authorization chain, the
  unchecked-operation check (#2387) and the read-only impersonation rollback (K-42) would each need
  a two-transaction meaning. Port declarations would need to reach the manifest, `substrat push` and
  the console. And a contract suite would have to cover all of it.
- *What it adds over (b):* the kernel, rather than host code, enforces the order of the three steps,
  and it saves one worker-to-DO hop. Under (b) the engine's state machine already refuses every order
  the regulation forbids (§4.2). A host driver that misbehaves can stall one till until its attempt
  expires, but it cannot break A1–A4.
- *Egress:* still DO-originated, still unpoliced.
- *Credentials:* still unsolved. The scope DO runs in the vertical's worker and holds none.
- *Blast radius:* every vertical's invoke path changes, to serve one consumer.

### 3.2 (b) Reserve-then-record

The engine opens an **attempt** in one operation, the call happens outside any transaction, and a
second operation records the answer or abandons the attempt. Nothing in the kernel changes.

- *Crash or eviction after the request left:* the attempt row committed **before** the request left,
  so the window is durable. The next attempt on that till abandons it first, journaling "outcome
  unknown", and only then opens. This meets A2 and keeps the in-doubt window visible.
- *Timeout:* the driver abandons the attempt with the failure. The request journal row is already
  committed, and the abandon adds the outcome. If the answer arrives after the abandon, recording it
  is refused, but the late answer **is journaled** (4:9 asks that what the register receives be
  registered) and the call returns `abandoned`. This meets A2, A3 and A4.
- *Retry:* opening an attempt carries the till's sale id as its idempotency key (#116), so a retried
  open replays the same attempt instead of opening a second one. Recording and abandoning are
  idempotent through the attempt's state.
- *Fence:* at most one open attempt per registration unit. That is free in practice, because a till
  serves one customer at a time. It is bounded by the attempt's expiry, so it is not the open-ended
  register lock #3289 objects to. Other tills on the same scope are unaffected, because the scope's
  queue is held only for the two short transactions and never for the call.
- *DO semantics:* none new. Two ordinary invocations.
- *Egress:* the call is host code in the vertical's worker, so D-46's egress worker enforces the
  declared host.
- *Regulation for an unanswered request:* no receipt, no registered sale amount (4:9, 6:2). The
  exchange and its lack of an answer are journaled (4:9, 4:10), the attempt counts as an uncompleted
  sale in X/Z (7:2 s, 7:3 t), and the receipt number stays free (7:1 d), subject to Q2.
- *Three-layer rule and R3:* untouched. The engine owns the invariants, the vertical owns the route,
  and the transport is host code.
- *Blast radius:* none outside the engine and the verticals that use it.
- *Latency:* two worker-to-DO invocations plus one HTTPS call. That is (a2)'s cost plus one in-colo
  hop, and well below #3289's worry about an outbox, a connector and a callback, which describes (c),
  not this.

The issue's objection to "moving the call into the vertical" is that it takes the regulated flow out
of the engine. Here the regulated **rules** stay in the engine, which refuses every forbidden order.
What leaves module code is the **transport**, which R3 already says belongs in host code. §6 Q6 asks
where that transport code lives.

### 3.3 (c) An engine plus a connector on the D-64/D-73 call contract

The engine emits `sale.requested`. A connector, either in the vertical's worker (D-64) or as its own
script (D-73), receives a `dispatch`, calls the unit, and writes back by invoking
`sale.record-control-code` as the connection principal.

- *Correctness:* (b)'s, provided the engine keeps the same attempt state machine. The connector is
  just a different driver.
- *Latency:* `dispatch` runs from a `connector:<provider>` intent. That means an outbox row, the
  router's kick, the control plane's drain, the router dispatching into the connector, and an invoke
  back: seconds when everything is up, and up to the 15-minute sweep when a kick is lost. This is the
  latency #3289 rightly rejects for a cashier with a customer waiting.
- *Availability:* the control plane is on the path of every sale. Under D-73 phase 1 it also opens
  the credential for every call, and phase 1 carries no scoped role (`dispatch` is refused, D-73
  §3.5).
- *What it gets right:* the platform keeps custody of the credential, and the provider protocol lives
  in a stateless package with one contract.
- *Blast radius:* router, control plane and contract changes, for a synchronous role the contract
  does not have.

(c) is the wrong path for the sale, but its packaging is right for the transport. §4.5 adopts it.

### 3.4 Side by side

| | (a1) in-txn port | (a2) host-staged port | (b) reserve-then-record | (c) connector dispatch |
|---|---|---|---|---|
| A1 no sale without a code | yes | yes | yes | yes |
| A2 failed exchange journaled | **no**: rollback erases it | yes | yes | yes |
| A3 gapless series | yes, until a crash reuses N blind | yes | yes | yes |
| Crash after send | invisible | durable, host resolves | durable, next attempt resolves | durable |
| Other tills during the call | **blocked** (K-6) | free | free | free |
| Unprobed DO behaviour relied on | yes | no | no | no |
| Egress policed by D-46 | no (DO) | no (DO) | **yes** (worker) | yes (router) |
| Kernel change | new verb, I/O in txn | new invoke lifecycle | **none** | none (contract and router change) |
| Hops per sale | 1 + call | 1 + call | 2 + call | outbox + drain + 2 + call |
| Credential custody | unsolved | unsolved | unsolved (Q3) | platform |

## 4. Recommendation: (b), with no new kernel verb

### 4.1 Shape

The engine is composed **by call**. Its in-scope exports run inside the vertical's operations and in
their transaction, and the vertical checks the permission. Each operation the vertical declares is
thin: the check plus one export. Names are illustrative.

```ts
// engine in-scope functions — module code, no network
openAttempt(ctx, { unit, sale }): { attemptId, receiptNumber, request }    // transaction 1
recordAnswer(ctx, { attemptId, answer }): Receipt | { abandoned: true }   // transaction 2
abandonAttempt(ctx, { attemptId, failure }): { abandoned: true }          // transaction 2'
```

```ts
// the driver — host code in the vertical's worker, never module code (R3)
const begun = await scope.invoke('till/begin-sale', { unit, sale }, { idempotencyKey: saleId });
let answer: ControlUnitAnswer;
try {
  answer = await controlUnit.send(begun.request, { signal: AbortSignal.timeout(budgetMs) });
} catch (failure) {
  return scope.invoke('till/abandon-sale', { attemptId: begun.attemptId, failure: describe(failure) });
}
return scope.invoke('till/complete-sale', { attemptId: begun.attemptId, answer });
```

`begun.request` is the exact payload the engine journaled. The driver sends it unchanged, and the
answer is handed back as received (raw), so that the engine parses it with its own schema and
journals what actually arrived.

### 4.2 Invariants the engine holds, whoever drives it

- `openAttempt` refuses while the unit has an open attempt that has not expired. An expired open
  attempt is first abandoned with outcome `unknown`, in the same transaction and journaled, and then
  the new attempt opens.
- The receipt number of an attempt is the unit's last **registered** receipt number + 1. Abandoned
  attempts don't advance it (A3, Q2).
- A receipt row exists only through `recordAnswer` on an open attempt with a code that parses. It
  is created in the same transaction as the counters and the sale's journal entries (A1, 6:2).
- `recordAnswer` on an attempt that was abandoned refuses and journals the late answer. It commits,
  and does not throw, because 4:9 asks that what was received be registered (A2).
- The journal is append-only (A4, 6:1). Outcomes are new entries. Abandoned attempts feed the X/Z
  "oavslutade försäljningar" count and amount.
- Every transition emits a fat event, as every engine mutation does.

### 4.3 Time

The driver holds the call's budget with an `AbortSignal`. The engine holds the attempt's expiry as an
engine option, judged with `ctx.now()`. It is longer than the driver's budget, so that an attempt the
driver is still waiting on can't be abandoned under it. No retry happens inside a sale: a failure is
an abandon, and the cashier tries again, which opens a new attempt with the same receipt number. The
numbers are §6 Q5. Tests inject small values and freeze the clock (`manualClock`), so no test waits
for the real budget.

### 4.4 The window no design closes

A request that left and got no answer may still have been signed by the unit. The next attempt then
sends a request with the **same receipt number and different sale data**. Whether a certified unit
accepts that, and what its own journal then shows, is a property of the unit and its certification,
not of this design. (a1) and (a2) leave the same window. (a1) merely forgets it happened. If the
unit refuses a reused number, then an abandoned attempt has used up a number with no receipt, and
7:1 d can't be met by **any** option without guidance on how such a number is recorded. That is §6
Q2, and it gates the engine whichever option is chosen.

### 4.5 Where the transport lives

The control unit protocol (request signing, the HTTP call, parsing the answer) goes in a **connector
package**: host code, stateless, taking the credential and a `fetch` per call, the D-73 shape. The
vertical's driver calls it in-process today. If the platform later takes custody of the credential
(Q3), the same package can be moved behind a synchronous connector-script role without the engine
noticing, since the engine only sees `request` and `answer`.

### 4.6 Tests

- **Engine suite** (`engine-test-kit`): drives `openAttempt`, `recordAnswer` and `abandonAttempt`
  directly, with a frozen clock for expiry, and asserts every refusal in §4.2 plus the gapless series
  under abandon, crash (an open attempt with no outcome) and a late answer. It needs no port fake,
  because the engine never calls out.
- **Driver and connector:** an injected `fetch`, the pattern the first-party connectors already
  use.
- **`adapter-sqlite` and the contract suites:** no change.

## 5. What K-62 decides, and what it leaves for later

K-62 (proposed) decides two things. An operation does not await an outside call inside its
transaction, and `OperationContext` gets no request/response verb for one. An exchange whose answer
decides a commit is an attempt the engine commits before the request leaves, plus a second operation
that records or abandons it, with the call made by host code between them.

(a2) is the shape to revisit if a **second consumer** needs the kernel itself to enforce the step
order, or if the platform takes custody of the credential and wants the call made in a host it
controls. Neither is true today. Revisiting it should start by probing the one unknown in §2 (a
`fetch` inside an async DO `transaction()`), so that the record has an answer rather than an
inference.

## 6. Open questions for the owner

1. **The wording in force.** Do 4 kap. 9 §, 6 kap. 1–2 §, 7 kap. 1 § d and 7 kap. 2–3 § ("oavslutade
   försäljningar") still read as quoted in §1.1 under SKVFS 2021:17, which Skatteverket applies from
   1 January 2027? And is the cloud unit certified as a *kontrollenhet* (SKVFS 2009:2: a code per
   receipt) or as part of a *kontrollsystem* (SKVFS 2020:9: the register waits for a local buffering
   program)? Under the second, the hard synchronous dependency is local, and most of this RFC
   applies only to the buffering program's interface.
2. **A number that got no answer.** Does the certified unit accept a later request reusing a receipt
   number whose earlier request went unanswered or was refused? If not, how does Skatteverket expect
   such a number to be recorded? This decides whether A3 holds, for every option (§4.4). It is a
   question for the unit's vendor and possibly for Skatteverket, not for code.
3. **Credential custody.** Under (b) the driver needs the unit's credential in the vertical's request
   path. Either the vertical holds it, which is D-64's stated trust shape ("the vertical holds the
   plaintext"), or the platform builds a synchronous connector-script role that opens it (D-73), which
   puts the control plane in every sale's path. Which, for phase 1?
4. **The series per till.** Is "one open attempt per registration unit" right for how the vertical
   models tills? A *tunn klient* (2 kap. 22 §) talking to a shared register program may change what a
   unit is.
5. **Budgets.** The driver's call budget and the attempt's expiry: the unit's documented response
   time, and how long a cashier will wait before it counts as an uncompleted sale.
6. **Where the driver lives.** Can an engine package ship a host-only subpath (outside everything
   reachable from its `ModuleRegistration`, so outside R3's reach) holding the driver, so that the
   whole regulated flow is versioned in one package? Or do the driver and the protocol both live in
   the connector package (§4.5)?
7. **The probe.** Should the workerd probe of a `fetch` inside an async `transaction()` (§2) be run
   now, for the record, even though this recommendation doesn't depend on it?

## 7. Not in scope

- The register engine itself: its schema, X/Z reports, the SKVFS 2021:16 XML export, and the grand
  total counters beyond A1.
- Payment terminals. A card payment is a second outside exchange, with its own ordering against the
  control code. This RFC's shape (attempt, call, record or abandon) applies to it too, but the
  ordering between the two is the engine's design.
- Any change to platform intents, the outbox or K-6.
