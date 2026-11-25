# No network in scope code: the spike

Evidence for [#3371](https://github.com/substrat-run/substrat/issues/3371), phase 1 of
[one-model-for-shipped-code.md](../../docs/rfc/one-model-for-shipped-code.md) (§10: *"whether no network in
scope code can be a mechanism on the platform today"*). Only the findings are kept here. The experiment
code is not: it ran from commit `bfd109821` of [PR #3384](https://github.com/substrat-run/substrat/pull/3384),
whose commits hold it, and **What was run** below says what it did.

## The answer

**Yes, by one route and no other.** The scope's class has to run as a Durable Object **facet** whose code
the Worker Loader loads with `globalOutbound: null`. The script uploads that code inert, as Text modules,
and its own Durable Object, platform code, loads it. Under that, every way out the spike knows of
refuses. Nothing reaches the network. The code's `env`, and the ambient `env` it could import, hold
only what the platform passed in. The same machinery with `globalOutbound` set to a platform entrypoint
instead of `null` enforces D-46's declared hosts from inside a Durable Object, which no mechanism does
today.

The two cheaper routes fail. A namespace outbound worker never sees a Durable Object's requests
(Cloudflare documents it, D-46 recorded it). A preamble that removes `fetch` leaves `connect()`.

| Route | Holds against an uncooperative bundle? | Holds on a dispatch namespace? | Verdict |
| --- | --- | --- | --- |
| Outbound worker on the namespace (D-46 today) | No. Durable Objects are not intercepted | No | Already built; stays the policy for **worker-context** egress |
| A refusing `globalOutbound` on the uploaded script | Would, but there is no such setting for a user Worker. The namespace outbound worker is that hook, and it skips Durable Objects | No | Not available |
| Removing `fetch`/`connect`/`WebSocket` from globals (a preamble, #861's Option B) | No. `connect()` and `node:net` still reached the sink | No | Refused, now on evidence as well as D-61's principle |
| Bindings only (the uploader decides what `env` holds) | Not alone. It removes no ambient global | Yes | A necessary half, and the whole surface once the facet route closes the globals |
| **Scope class as a loaded facet, `globalOutbound: null`** | **Yes.** All eight network exits refused, nothing arrived | **Yes.** D-70's deployed run showed `fetch()` and `connect()` throwing in a loaded facet on a real namespace | **The mechanism** |
| Same, `globalOutbound` = a platform policy entrypoint | Yes. A declared host passes, an undeclared one is refused by platform code, sockets fail | Not yet run deployed | The way to give scope code a declared, policed exit, if one is ever wanted |

## What was run

Local workerd through Miniflare `4.20260730.0`, the pin store-facets uses, on 2026-11-24 and
2026-11-25. The "network" was a sink on `127.0.0.1` (HTTP, WebSocket, raw TCP) that recorded every hit
by the label in its path or first line, so a result was judged by what **arrived**, not by whether the
call threw. One probe module tried every way out, and every script ran it byte for byte, so a
difference in the answers was a difference in where the code ran. 29 checks, all passing, in seven
runs. Four scripts in one runtime:

| Script | What it was |
| --- | --- |
| plain | Today's shape: the scope class is part of the uploaded script |
| plain behind a local `globalOutbound` | The same, to show that a local outbound covers a Durable Object, which production's does not |
| locked | The same, behind a preamble imported first that clears `fetch` and `WebSocket` off the global and every prototype on its chain |
| supervisor | A platform Durable Object that loads the scope's code inert through the Worker Loader, runs it as a facet, and picks its `globalOutbound`: `null`, a policy entrypoint, or inherited. It also holds the control-plane and scope-work entrypoints it hands over, and a stand-in for the scope class that does what `adapter-cloudflare/src/scope-do.ts` needs of its runtime |

The probes were: `fetch`, a `fetch` found on the global's prototype chain, `fetch` with `Upgrade`,
`new WebSocket`, `connect()`, `node:net`, `node:http`, `import()` of a URL, the Cache API and the
ambient `cloudflare:workers` env. The same commit carries a runbook for the deployed half, for a
person holding a test-account credential. It was not run.

### Every way out, by where the code runs

What arrived at the sink. A dash means nothing arrived.

| Exit | Plain DO (today) | Behind the preamble | Facet, `null` | Facet, policy, declared host | Facet, policy, undeclared host |
| --- | --- | --- | --- | --- | --- |
| `fetch()` | arrived | — refused by the preamble | — throws | arrived | — 403 from the platform entrypoint |
| `fetch` off the prototype chain | arrived | — none left | — throws | arrived | — 403 |
| `fetch` + `Upgrade: websocket` | arrived | — refused | — throws | arrived | — 403 |
| `new WebSocket()` | arrived | — no constructor | — throws | arrived | — refused |
| `connect()` (`cloudflare:sockets`) | arrived | **arrived** | — throws | — fails (an entrypoint takes no CONNECT) | — fails |
| `node:net` | arrived | **arrived** | — throws | — fails | — fails |
| `node:http` | arrived | — no answer | — no answer | arrived | — 403 |
| `import()` of a URL | — never supported | — | — | — | — |
| Cache API | stores locally, no origin request | same | absent in the facet | absent | absent |
| `env` / ambient `env` | the script's bindings | the script's bindings | **only what the supervisor passed** | same | same |

The workerd error under `null` reads: *"This worker is not permitted to access the internet via global
functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside
world."* The Cache API is no exit in any column: it never sends a request to an origin, and in an
untrusted dispatch namespace `caches.default` is disabled anyway (Cloudflare, *Worker Isolation*).

The preamble fails on a property of the language, not of its author. `connect` is an export of a
built-in module. A preamble cannot delete it, cannot wrap it for a module that imports it directly,
and `node:net` is built on it.

### What the scope class needs, inside a facet

| Need (from `scope-do.ts`) | In a facet |
| --- | --- |
| Synchronous `ctx.storage.sql` in `transactionSync` | Yes, and it persists across calls |
| `setAlarm` / `alarm()` (the live reaper) | **No:** *"alarms are not yet implemented for SQLite-backed Durable Objects"*, while the same alarm on a plain SQLite DO fires. **Workaround proven:** the supervisor holds the alarm and forwards it to the facet |
| Hibernatable WebSockets (`acceptWebSocket`, live reads) | Yes. A socket accepted by the facet answers through the supervisor |
| `CONTROL_PLANE` (a Durable Object namespace today) | Not as a namespace: a loaded worker's env refuses one (*"Could not serialize object of type DurableObjectNamespace"*). Yes as an entrypoint stub the supervisor hands over |
| `SUBSTRAT_SCOPE_WORK` (an Analytics Engine dataset) | Not as a dataset (does not serialize). Yes as a stub that writes for it |
| `SUBSTRAT_VERSION_ID` and the other vars | Yes, plain values pass |
| Another Durable Object (scope to scope) | Only through a stub the supervisor hands over. The loader refuses a namespace and a Worker Loader in env too, so by construction every reach goes through platform code |

### A trap found on the way: the loader caches the env with the code

`LOADER.get(id, …)` caches the loaded worker **by id, env included**. With one id per code version (the
natural choice: every scope of a version runs the same code), a per-scope stub put in the env answers
for whichever scope loaded that id first. In the run, scope `scope-b` asked the control plane who it
was and was told `closed`, the first object to load. **Per-scope capabilities must travel per call, as
RPC arguments, never in the loader env.** The run shows the fix: the same stub handed as an argument
answers for each scope correctly. The same caching makes `globalOutbound`'s props per id, so per
version, and that is exactly D-46's granularity: *the policy follows the bundle*.

### Cost, as far as a local run can say

| Figure | Local result | What it is not |
| --- | --- | --- |
| The hop the facet adds, timed inside the runtime | supervisor → facet **0.04–0.05 ms**, against supervisor → a sibling DO **0.04 ms** (n = 500, three runs on a quiet machine) | An edge figure. The facet runs on the supervisor's machine, so the hop costs about what a DO call does |
| Load of a 2 MB scope bundle, timed from outside (Miniflare's own hop included) | cold, on a loader id never loaded before: **14–18 ms**; warm **0.7–0.9 ms**; a fresh object on an id already loaded: **8–9 ms** (three runs, quiet machine) | A real vertical's bundle on the edge. D-70's 7.6 MB Python graph release took 2.1–3.2 s deployed. A JavaScript bundle should be well under that, but is unmeasured |
| Billing | not observable locally | D-70: $0.002 per Dynamic Worker per day past 1 000 a month. With one id per version the count is about the live versions. D-70 also saw two objects on one id reach two isolates deployed, so whether the bill counts ids or isolates is open |

Earlier runs on a heavily loaded laptop gave figures up to twenty times higher (cold 150–320 ms, hop up
to 1 ms). They measured the machine, not the facet, and are not used.

The costs that are not runtime figures are larger:

1. **Storage moves.** A facet's SQLite is its own, not the supervisor's (D-70). Every existing scope's
   rows, the `_substrat_*` spine included, sit in the scope DO's storage today. Turning this on for an
   existing scope is a one-time copy per scope, run by platform code at first wake. The alternative is
   to turn it on for new scopes only. Leaving the data in the supervisor and handing the facet an SQL
   stub is not an option: it makes `ctx.sql` asynchronous, and the kernel relies on synchronous
   transactions.
2. **The build splits.** Today the scope class is defined inside the vertical's own bundle
   (`defineScopeDO(MODULES, …)` in the vertical's `src/worker.ts`). For the code to travel inert, the
   kernel and the modules have to be emitted as a scope bundle of their own, separate from the
   worker entry. That is the generated entry's job (#3378, D-76), so this route depends on it.
3. **The kernel's own reach becomes stubs.** `CONTROL_PLANE` and `SUBSTRAT_SCOPE_WORK` become
   entrypoints on the supervisor, the alarm moves to the supervisor, and per-scope stubs go per call.
   The scope class makes no `fetch` of its own today. The only DO-side fetch in the adapter is the
   scope sweeper's drain call (`scope-sweeper-do.ts`), and that is platform code that stays
   supervisor-side.

## Where the boundary is

The kernel and the vertical's modules have to share the facet: synchronous SQL in `transactionSync`
needs them in one Durable Object, so in one isolate. That decides what the mechanism protects.

- **The boundary is the isolate's edge, not the kernel.** Code in the same isolate can change what the
  kernel runs on, for example by overwriting a prototype on `Array` or `JSON` that a check relies on.
  The kernel's in-isolate checks guard against mistakes. What holds against an uncooperative bundle is
  outside: no network, a database holding only the scope's own rows, and the stubs the supervisor
  passes in.
- **Every stub passed in must be safe for the vertical's code to call directly.** The modules can reach
  anything the kernel can. A stub is narrowed to one scope by its props and checks authority on its own
  side, never trusting that the kernel checked first.
- **Scopes of one code version can share module-level state.** With one loader id per version, the
  loader may run several scopes in one isolate, as the env trap above shows, or give a scope a fresh
  one. A module-level variable is evaluated once per isolate, so scope-specific data held there can
  answer a request from another scope. This is not new: today every scope object of a script can share
  an isolate in the same way. The control chosen is the existing one: vertical and kernel code keep no
  scope-specific data at module scope, and scope code depends on neither reuse nor a fresh isolate. A
  loader id per scope would separate module state, at the price of one live id per scope (the open
  billing question above), and buys nothing today's shape has.
- **No secret enters the scope's isolate.** Whatever the kernel can read, the modules can read. A key
  the kernel needs, such as one that signs an envelope, stays with the supervisor or a platform
  service, and the scope asks for a signature through a stub.
- **The platform composes the kernel into the scope bundle at build time.** It uses its own pinned
  kernel, or at least checks its hash. That stops a vertical from shipping a modified kernel. It does
  not stop the modules from changing the kernel's behaviour while it runs. Whether they can reach a
  built-in prototype such as `SqlStorage.prototype`, and whether freezing the intrinsics before the
  modules load (in the style of SES `lockdown`) works in workerd, is untested.

## How a module reaches HTTP

Not from inside the scope, and not through another scope. The scope writes a platform intent
(`ctx.requestPlatform`): a row in its own `_substrat_platform_requests`, committed with the operation.
The router sees the response flag and kicks the control plane, or the sweep finds the row later. The
control plane reads the row through the vertical's deployment and runs the handler for its `kind`. For
a third-party call, the handler is a connector running outside any Durable Object (D-64), and the
answer comes back as a second operation that records it. That is two steps, never a read mid-logic,
which is what K-62 already asks. One gap: no general "fetch this URL" intent exists today. The
handlers are privileged platform jobs, so a vertical that needs outside data waits on connector
delivery (#3365).

## How it meets the decisions around it

- **D-46 (egress allowlist).** Worker-context egress keeps the outbound worker. The scope DO's gap closes:
  under `null` there is nothing to police. Under the policy entrypoint, D-46's declared hosts would be
  enforced from inside a Durable Object, and that entrypoint can forward to the existing egress worker
  so one place decides and meters. The same caching gives per-version policy for free.
- **D-58 / D-61 (observed, never refused).** D-61 refused a wrapper because *who hands the capability
  over* decides whether something is enforcement. Here the platform hands it over. The scope code never
  holds the real `fetch`, because the runtime builds its isolate without one. That is D-61's own test
  passed, the way the spine guard passes it, so this route is consistent with D-61. It would amend
  D-61's "never refused" for scope code only. D-61's honest occupant, the auth-server's issuer, is a
  vertical's **own** Durable Object class, not the kernel's scope class. It is untouched unless the
  route is extended to it, and `null` would break its federated calls. A declared-host policy cannot
  express its host set either (D-61), so it stays an exception, declared rather than silent.
- **D-64 (vertical connectors).** Provider code runs in the vertical's worker, called through the
  router, so the outbound worker already bounds it. Nothing here touches it. It agrees with the
  direction: network parts live outside the scope, and a connector's scoped call enters the scope
  through the door.
- **D-70 (store drivers).** The same machinery: a supervisor, inert code, a facet, `globalOutbound:
  null`. One difference: the scope's loader id can be per version, not per object, because the code
  is the vertical's own and per-tenant separation is not what it buys. That is exactly why the env
  trap above matters.
- **K-62 (no outside call inside a transaction)** becomes mechanical for scope code under `null`.
  **RFC §7.2 / K-64 (the store call)** stays the proof route: the host makes the call. A `ctx.store`
  inside an operation would need a per-call stub, which is #3370's question.
- **Boundary-lint R3** (no `fetch` in module code) stays as the fast local answer. It stops being the
  only one.

## Recommendation

1. **Record it as a decision, proposed.** No network in scope code becomes a mechanism by running the
   scope class as a facet loaded with `globalOutbound: null` from an inert scope bundle. It amends D-61
   for scope code and leaves the outbound worker as worker-context policy. Do not build the preamble or
   anything over `fetch` in the bundle.
2. **Build it behind the generated entry (#3378), for new scopes first.** It needs the scope bundle to
   be emitted separately, and the storage move is the costly part. A new scope has nothing to move.
   Existing scopes follow by a copy at first wake, once that copy is proven on the spine.
3. **Before building, run the deployed half on a test account** (the runbook in PR #3384's commits).
   Four facts only a deployment gives:
   - whether a facet may hold its own alarm on the edge (the supervisor workaround is proven either way);
   - whether `ctx.exports` and a policy `globalOutbound` work in a namespace script;
   - the cold start of a 2 MB JavaScript scope bundle on the edge (a real vertical's waits for the split bundle);
   - whether the bill counts loader ids or isolates.
   It also re-shows D-46's limit on the same run: worker-context `fetch` is refused by the outbound
   worker, and the plain DO's is not. And it answers one question D-46 left open: whether the outbound
   worker also closes `connect()` for a Durable Object.
4. **Keep `null`, not the policy entrypoint, as the default for scope code.** The RFC's target is *no*
   network in the scope. The policy mode exists for a declared need nobody has today, and for a
   vertical's own DO class (the issuer case) if that is ever brought under the same roof.

## Not shown

- Anything about production isolate placement, beyond what D-70 measured.
- The storage copy for an existing scope. Not attempted here.
- A real vertical's scope bundle. The cold-start figure uses a 2 MB padding module.
- Python scope code. D-70 showed `null` holds for Python too, and the platform has no Python scope class.
- Runtime tampering with the kernel from the modules, and whether freezing the intrinsics prevents it
  (see **Where the boundary is**).
- The vertical's **worker** code. The route closes the scope's Durable Object and leaves the rest of the
  script alone. Worker-context egress is policed by the outbound worker when the router dispatches.
  When the control plane reaches the vertical through its own dispatch binding, for example to drain
  intents, the call passes no egress worker, so worker code running under it has unrestricted network
  (D-64's "policy-free egress" follow-up). Read the spike as "no network in scope code", never as "no
  network in the vertical".
