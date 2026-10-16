---
status: proposed
layer: plan
description: One chat in every product — a thread with an AI, and sometimes a person, that answers and acts for the signed-in user, with the assistant stamped as actor under a ceiling. Argues the stream protocol, the record, the host loop, the UI element, context, memory and the support handoff, and the bar for the experience.
---

# RFC: the assistant — one thread, any product, acting for the user

**Status: proposed. Nothing here is agreed.** It recommends; a human decides. The decisions it
asks for are collected in §16, where the ones taken as working decisions for P1 are marked. Written against `origin/main` at `c95e6d73a` and against the
outside world as of 2026-10-14; revised on 2026-10-15 after three review rounds, mainly to
add the actor and its ceiling (§6.0), which the first draft lacked. Claims about the repo carry a file or an issue; claims about
the outside world carry a source in the Sources section at the end; anything I could not check says so in §15.

Related: [#1824](https://github.com/substrat-run/substrat/issues/1824) (delegated MCP access),
[#1073](https://github.com/substrat-run/substrat/issues/1073) (platform-side inference),
[#1749](https://github.com/substrat-run/substrat/issues/1749) (AI text with provenance in the
dashboard), [#1705](https://github.com/substrat-run/substrat/issues/1705) (cross-vertical
events), [#1671](https://github.com/substrat-run/substrat/issues/1671) (what K-15 says about
runtime UI), [#112](https://github.com/substrat-run/substrat/issues/112) (the MCP surface),
[#1454](https://github.com/substrat-run/substrat/issues/1454) (closed: "two apps is not enough
evidence to extract"). Companions: [scope-stores.md](scope-stores.md),
[agent-surface.md](agent-surface.md). Decisions it builds on:
[K-42](../decisions/K-042-an-impersonated-operation-carries-two-actors-and-the-permis.md)
(a second actor, stamped by the kernel),
[K-43](../decisions/K-043-the-kernel-indexes-attachment-text-it-does-not-parse-file-fo.md)
(attachment text),
[K-46](../decisions/K-046-subject-erasure-reaches-a-module-s-own-tables-by-declaration-or.md)
(erasure of a module's tables),
[K-49](../decisions/K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md)
(a scope store, proposed).

---

## 1. The need, and the bar

A vertical today can be driven by an agent through its MCP endpoint. That works well for
people who already live in Claude or a similar client, and it is not how most users meet
software. Most users will use the product's own chat, or none.

Four products want the same thing, in four shapes:

| Product (by shape, not name) | What the chat is for |
|---|---|
| A training-plan app | A coach: knows the user's programs and history, logs sets, adjusts a plan |
| An internal CRM for a service company's staff | Ask questions of the data, make changes, with an audit trail |
| ticket0, the support desk | Answer from the knowledge base, hand off to a person. It already runs an assistant of its own (§12.1) |
| The dashboard and the builder portal | "Why did my deploy fail?", "show me failing apps", then act |

The user's own framing is the requirement: *as a user I want a chat that can answer my
question and solve my issue; whether it is a person or an AI, I do not care.* So this is one
experience, not an AI feature plus a support feature.

**The bar is high on purpose.** A clunky chatbot is worse than none: it teaches the user not
to try, and it makes the product look careless. A good one is the thing that makes the app
stand out. §10 turns "good" into a checklist that can fail a release, and §11 does the same
for the developer who adds it. Both are part of the deliverable, not polish after it.

## 2. Principles

These are the parts of the design that are not up for trade during implementation.

1. **The assistant acts for the signed-in user, never as them, and never above them.** Every
   call the loop makes carries two identities: the user it acts for, and the assistant as its
   actor. Its authority is the user's permissions intersected with an assistant ceiling, which
   the host enforces and the tenant can narrow. It is not a promise the loop keeps. Every record
   of the call names both (§6.0). One stated exception: P1, read-only on the dashboard, runs
   before the host can enforce a ceiling. There the ceiling is the tool list, and the actor is
   recorded on the dashboard's own request record, not by the control plane (§6.0, §12.1). No
   write runs under the exception.
2. **One thread, three kinds of participant:** the user, the AI, a human agent. A person
   joining is a participant joining, not a different product.
3. **The thread is the product's data.** It lives in the product's own scope, under its
   permissions, audit trail and erasure. It is not a vendor's log.
4. **Protocol first, UI second.** The stream protocol is the contract. The element, a React
   wrapper and a bespoke native chat are all clients of it.
5. **Context is assembled, memory is owned by the user.** What reaches the model each turn is
   built deliberately. What we remember about a person is small, visible, editable and
   deletable, and we can say where each item came from.
6. **Untrusted text never decides a consequential action alone.** Anything a stranger could
   have written (a customer message, a note, an imported field) is data, not instruction.
7. **Cost is bounded by construction**, per user and per day, before the call goes out.
8. **Extract from evidence, build for the next consumer.** Five consumers are planned; §12
   orders them so each one tests whether the shared part is really shared.

## 3. What exists outside, and what it means for us

### 3.1 Cloudflare

**Agents SDK, `AIChatAgent` and `Think`.** `AIChatAgent` (`@cloudflare/ai-chat`) is a Durable
Object class that persists messages to SQLite, resumes a stream when a client reconnects,
broadcasts to every connected client, supports server tools, client tools and human approval
(`needsApproval`, which survives a page refresh and hibernation), attaches typed `data-*`
parts to messages, caps stored messages and compacts rows near the 2 MB SQLite limit. It is
built on the AI SDK's `UIMessage`. `Think` sits above it: messages as a **tree** (regenerating
creates a branch), persistent **context blocks** the model can read and write, FTS5 search
across sessions, **non-destructive compaction** (a summary overlay, originals kept), and
sub-agents. `runTurn()` is marked experimental; I could not tell whether Think as a whole is.

**What to borrow, and what not to adopt.** The shapes are right and we should copy them:
resumable streams, approval that survives a refresh, a message tree, compaction as an
overlay, typed data parts. Adopting the class itself is wrong for us. It is a Durable Object
in the *vertical's* worker that calls `env.AI` directly, which is the capability-holding
problem [#1073](https://github.com/substrat-run/substrat/issues/1073) exists to remove: a
pushed vertical could call any model on our account, unmetered, unattributed. It would also
put the transcript in the agent's own SQLite instead of the scope's, outside permissions,
audit and erasure (principle 3).

**AI Gateway** is the platform-side half. Relevant, current features: caching; **spend limits**
in dollars, scoped by model, provider or custom metadata such as a user id (eventually
consistent, so a burst can briefly overshoot); rate limiting; retries and model fallbacks;
guardrails and DLP; dynamic routing and an Auto Router; BYOK; unified billing; `byok_only` to
prevent fallback to Cloudflare-managed credentials. Limits worth knowing: five custom
metadata entries per request, and a 200 requests per 60 seconds cap per gateway on requests
using Cloudflare-managed credentials (not BYOK). The platform's model host already layers the
gateway's per-request metadata
([model.ts](../../packages/vertical-host/src/model.ts)); per-user budgets can ride on it.

**AI Search** (formerly AutoRAG) is managed retrieval over uploaded or connected data, with
per-tenant instances and metadata filters. That is a good fit for the knowledge-base tool in
ticket0 and for "help" content in any product. It is not where user memory belongs (§8).

**Durable Object WebSockets with hibernation** keep a client connected while the object is
evicted and wake it on a message. Duration is not billed while hibernating. An outbound
WebSocket does not hibernate. This is the right primitive for a live thread.

### 3.2 Wire protocols

- **AI SDK UI message stream.** Typed *parts* with start/delta/end lifecycles (text,
  reasoning, tool input and output, files, `data-*`), over SSE, with a version header for
  custom backends. Tool approval streaming arrived in a later major version. Its shape has
  moved between majors (a line-based format, then SSE; Cloudflare's own changelog shows
  renames such as `addToolResult` to `addToolOutput`).
- **AG-UI.** A framework-neutral, event-driven protocol (about 16 to 17 event types) built for
  the agent-to-user hop: approvals, shared state, interrupts, generative UI, over SSE or
  WebSockets. Broader than the AI SDK's format, with CopilotKit as the main implementation.
- **MCP Apps.** An extension that lets a tool result carry a UI, rendered in a sandboxed
  iframe by the host, with a fallback to text. Relevant to the *other* door (our MCP
  endpoint), not to our own element.

**Reading.** `ai` is already a dependency of `vertical-host` (the model host calls
`generateText`), and Cloudflare's chat stack speaks the same message shape. Adopting its
*shape* costs nothing. Adopting its *package types as our contract* would tie the published
element to a library that has changed its wire format across majors. Hence §5.1: own the
schema, align the shape, adapt at the edge.

### 3.3 Context and memory practice

Three mechanisms are now standard, and they address different growth:

| | What it fixes | Lossy | Note |
|---|---|---|---|
| Compaction (summarise old turns) | Whole transcript too long | Yes, drops verbatim detail | Costs an extra inference call; obscure specifics are what it loses |
| Tool-result clearing | Stale, re-fetchable tool output | Content is re-fetchable | Invalidates the prompt-cache prefix when it fires |
| A memory store the model reads and writes | Cross-session knowledge | No, for what was saved | Quality depends on what gets written |

Anthropic documents these as API features (`compact_20260112`, `clear_tool_uses_20250919`,
`memory_20250818`). Our model host is provider-neutral, so we implement the policy in the
host and use a provider's server-side version only where the row supports it.

Findings that change the design:

- **Compaction can silently drop standing rules.** Reported results show safety constraints
  disappearing from a long context after summarisation. So standing instructions are never
  part of what gets summarised; they are re-injected each turn (§7).
- **Durable state belongs outside the window.** The pattern that holds up is an index read
  first after every compaction, plus an append-only record of decisions.
- **Remembered facts go stale.** Treat a remembered fact as a claim to verify before acting
  on it, especially when the app can look the answer up.
- **Store distilled facts, not transcripts.** Vendor guidance (Mem0, so read with the usual
  caution) and the survey literature agree on this.
- **Authored beats inferred.** Lovable's "memory" is workspace and project *knowledge*: plain
  text a person writes and edits, always in context, capped at 10,000 characters per field,
  with project winning over workspace on conflict. Anything conditional is a *skill* that loads
  only when a request matches. The agent does not write it, so there is no opt-in switch to
  argue about. It is a builder tool, not memory about an end user, but the lessons transfer: a
  readable, size-capped text beats clever inference, scopes nest (tenant-wide, then per user),
  and "always in context" is a different thing from "retrieved when relevant". The vendor's
  own docs warn that instructions may be followed less consistently in very long conversations,
  which is the compaction problem above.
- **Suppress is not delete.** A memory hidden from the model, or removed from a retrieval
  index, is not erased if the source it was derived from survives, or if a vector copy
  remains. Models do not unlearn. Several consumer assistants have been reported to resurface
  memories users believed deleted.

### 3.4 Security

The useful framing is Willison's "lethal trifecta": private data, exposure to untrusted
content, and a way to communicate outward. An agent with all three can be steered into
leaking. A 2025 paper by authors from IBM, Invariant Labs, ETH, Google and Microsoft argues
that general-purpose agents cannot be made reliably safe by detection, and proposes
constraining them by design: once untrusted input has entered, the agent's possible actions
are limited so that input cannot trigger a consequential one. CaMeL (Google DeepMind) is the
strongest variant: a privileged model plans in a restricted language, a quarantined model
reads untrusted data without tools, and data flow is tracked. Products that sell "catches 95%
of attacks" are, in the security community's view, selling a failing grade.

Our position follows: **constrain by architecture** (§6), keep a detection layer (AI Gateway
guardrails) as defence in depth, and never as the control.

### 3.5 Experience and accessibility practice

Practitioner consensus, not a standard: a visible Stop that keeps the partial output; retry
(reliability) distinct from regenerate (quality), and regenerations kept, not overwritten;
auto-scroll only when the user is at the bottom; tool steps shown by name while they run;
confirmation proportional to reversibility (preview and approve for irreversible, audit with
undo for reversible, to avoid alert fatigue); no raw chain-of-thought streamed by default.
For screen readers the converging advice is to **keep token streaming silent and announce one
completion** (and only on success), announce tool prompts and approvals as discrete events,
and avoid wrapping the whole transcript in a live region. These sources are blog posts and
issue threads; §10 requires testing with real screen readers rather than trusting them.

## 4. The shape

```
<substrat-assistant>            UI only. No logic.
        │   stream protocol (schema in contracts; SSE, resumable)
assistant-client                headless: connection, state, resume, approvals
        │
assistant host                  host code in vertical-host; the loop; one per thread
   ├── context assembly ───────► §7
   ├── model host ─────────────► platform inference: credential, budget, ledger (#1073)
   ├── tools ──────────────────► the vertical's own operations, for the user, actor stamped (§6.0)
   ├── record ─────────────────► engine-assistant (thread, messages, trace, approvals, memory)
   └── handoff ────────────────► a support desk (ticket0 first), via a contract
```

The loop is host code because it needs the network and streaming, which module code does not
have. The engine is the record, and it never talks to a model. The loop in the host is the
only thing that touches both, so the layer rules and the star topology hold. Nothing here
forks an engine: a vertical composes the engine and adds its own persona and renderers.

### 4.1 Why not simply the MCP surface

`mountMcp` already derives tools from a vertical's operations and calls them as the
authenticated principal ([mcp.ts](../../packages/vertical-host/src/mcp.ts)). The in-app
assistant should reuse that derivation and that call path, so there is one list of "what can
be done and who may do it". The MCP door stays for Claude and others; the assistant is the
second door onto the same operations.

What reading `mountMcp` end to end (P0) showed, and what it changes here:

- **The tool list is static.** `mcpToolsOf(operations)` is derived from declarations fixed at
  deploy. `tools/list` is deliberately **not** filtered by what the caller may do: the file
  says why (ticket0 routes 59 operations and its admin role holds 16 of its 19 permission
  keys, so a permission filter would remove almost nothing), and that `ScopeStub` has no way
  to read a principal's keys (connectors have `grants()`; a stub does not). Curation is
  `mcp: false` per operation today, and per-consumer scoping later (#111).
- **A call is `stub.invoke(operation, input)` on a stub resolved per request** (`mcp.ts:631`,
  `:825`), the same path the HTTP mount uses. The principal is the stub's, so authority is the
  user's, and a refusal is returned **in-band** (`isError`) for the model to read. A 401 is the
  one error that is not swallowed. The same fact is the gap §6.0 closes: on this path the host
  cannot tell a call the model chose from one the user made, so nothing can hold the model
  below the user's role, and history credits the user with both.
- **So the assistant's curation is the explicit `assistant.expose` opt-in (§6.1), not a
  permission filter.** Fifty-nine tools in a prompt is also a cost and an accuracy problem, not
  only a safety one. The derivation and call path are reusable; the default is inverted (MCP
  is on unless `mcp: false`; the assistant is off unless exposed). `mcp.ts:15-17` argues
  against a per-operation `mcp:` block, and this adds one, so the reason has to be stated: the
  MCP door is used by a person who picked a client and points it at their own data, while the
  assistant is a model the *product* puts in front of every user, so the product answers for
  each tool it offers. **Proposed, maintainer to confirm (§16 Q15):** one derivation, with
  `assistant.expose` as a filter over what `mcpToolsOf` yields, so an operation hidden from
  MCP (`mcp: false`, or no HTTP route) cannot be exposed to the assistant, and a gate refuses
  the declaration that tries. The two lists then cannot drift apart in the direction that
  matters.

## 5. The parts

### 5.1 The stream protocol (`contracts`)

A Zod schema `assistantStreamEvent`, owned here, **shaped like** the AI SDK's `UIMessage`
parts so a mapping to and from it is mechanical. It lives at the experimental subpath
`@substrat-run/contracts/assistant-stream` (#2304), kept out of the package root until a
consumer settles it. The contract's names are the ones this RFC uses: text
(`text-start`/`text-delta`/`text-end`), `tool-input`, `tool-output`, `approval-request` and
`approval-resolved`, `source`, and for what is ours, `data-provenance` (the "AI" marker, when,
from how many sources, the query it ran: what #1749 asks for) and `budget-notice`. Still to
come, as new event types when a phase needs them: reasoning (collapsed by default), file,
participant-joined, handoff-state and memory-proposed.

Why own it: the published element and the clients must not break when `ai` ships a major.
Why align the shape: Cloudflare's chat stack, `useChat`-style hooks and AG-UI adapters then
come nearly free. An AG-UI adapter is a later, optional edge.

Resumability is part of the contract, not an add-on: every event carries a monotonically
increasing id, and a client reconnects with the last id it saw.

### 5.2 `engine-assistant`, composed by call

The engine owns the invariants and nothing else:

- **Messages are append-only.** A message has a parent (a tree), so regenerate and edit-and-
  resend create branches. Nothing is overwritten.
- **A gated tool call cannot run without an approval**, bound as §6.0 point 3 says: to the
  approving principal, the thread, the call, the operation and a digest of the proposed input,
  single-use and expiring. The digest alone shows only that the arguments did not change; the
  binding to the principal is what shows the *user* said yes, and it needs the host to tell
  the user's call from the loop's (§6.0).
- **A tool call's states only move forward** (proposed, approved or denied, running, done or
  failed).
- **Every mutation emits a fat event, except for message text.** Message text is declared
  `erasable`, and K-46 keeps an erasable field off every event. So a message event carries the
  thread, the message id, its parent, the participant and the kinds of its parts, and not the
  words. Nor a digest of them: an unsalted SHA-256 of "yes", a phone number or "I have a bad
  left knee" can be confirmed by guessing, and it would outlive erasure on the event and in
  any Tier 2 copy. Digests of text and of tool inputs live on the row, which K-46 erases. No consumer may depend on the text; one that wants it is a sign
  the thread is being read for something §8 does not allow. This also settles the Tier 2
  question for the text: it never enters a payload, so there is no lake copy to erase.
- **Memory items carry their source and are subject-keyed** (§8).
- **Participants join and leave** with a recorded kind and time.

Entities, as a sketch (names are not decided):

| Entity | Holds |
|---|---|
| `thread` | subject (the user), product context, status (open, handed-off, closed), timestamps |
| `participant` | kind (`user`, `ai`, `human-agent`), principal or persona, joined and left |
| `message` | thread, parent, participant, parts, status, created |
| `tool_call` | message, operation, input digest, result digest and reference, state, approver, times |
| `memory_item` | subject, kind, text, source message, confidence, expiry, state (§8) |
| `handoff` | thread, desk, external reference, the summary the user saw, consented at, state |

**Do not copy tool results into the record.** Store a digest and a reference to the operation
that produced them. It keeps rows small (a Durable Object row has a hard size ceiling, and
the repo has already hit it once), keeps the customer's data in one place, and means erasing
the source erases the trace's content.

### 5.3 The host mount (`mountAssistant`)

Next to `mountMcp` in `vertical-host`. It owns: the loop with a **step bound**; the approval
pause; streaming and resume; the persona; budget checks before each model call; tool
derivation from operations; context assembly (§7); and the handoff.

**Where the live thread runs is the main open design question (§16, Q2).** Options:

1. **In the request, `waitUntil` plus SSE**, resuming by replaying persisted events from the
   engine. Simple, no new object, weaker on a long run and on reconnect mid-turn. This is the
   shape ticket0's existing assistant already has (`demos/ticket0/harness/assistant.ts`, run
   under `executionCtx.waitUntil` after the widget's response has gone).
2. **A Durable Object per thread** holding the WebSocket (hibernating) and the in-flight run,
   with the engine still the record. This is a platform-run object per scope, which is exactly
   what [scope-stores.md](scope-stores.md) and [K-49](../decisions/K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md)
   (proposed) describe as a *kind*. I have not checked whether the assistant fits that
   mechanism; it looks like a natural first non-trivial kind.
3. **Cloudflare's `AIChatAgent` in the vertical's worker.** Rejected in §3.1.

**P0 ran both** ([spikes/assistant-thread/FINDINGS.md](../../spikes/assistant-thread/FINDINGS.md),
local workerd, a scripted model). What it showed:

- **The placement is not the load-bearing choice.** A record with a single-writer lease and
  fencing, plus a loop that decides its next step from the record, made both placements pass
  every correctness assertion with the same loop code: exact resume after a disconnect,
  approvals bound to an input digest, recovery of a run cut off mid-step, one turn started
  when two sends race. Build those first and the placement can change later without touching
  the engine, the protocol or the clients.
- **Option 2 is the better coordinator, for product reasons.** A reply that arrives from
  outside any user request (a human agent answering after a handoff) has nowhere to be pushed
  from in option 1 except a client polling the record, which lagged 57 to 91 ms at the median
  against about 0 for a push. A run that dies with nobody watching stays dead in option 1 until
  the user returns, and was finished by the object's own alarm in option 2 (2.7 to 2.8 s, no
  client). And the documentation caps `waitUntil` at 30 s after the client leaves, which a
  multi-tool turn can exceed; that cap did **not** reproduce locally, so it rests on the docs
  until P0b.
- **Option 1 is a legitimate first step** for short turns with no human participant, because
  it needs no new object and the loop is the same.
- **Recommendation:** placement-agnostic loop and record in P1, option 2 as the live
  coordinator, option 1 as the fallback shape and not a second implementation. Confirm it
  deployed (P0b) before relying on it.

Option 2 sharpens one requirement: its alarm can run a step with no request and no client
attached, so there is no credential to re-derive authority from. §6.0 point 4 settles it: an
alarm may end a turn in a defined state, or finish a model step that calls no tool, and
nothing more. A tool step waits until a client with a live session attaches. So the thread
object holds no credential, and the record carries where the run is, not what it may do.

The protocol in §5.1 is identical either way, so the choice does not leak to clients. How a
vertical is given the object (a scope-store driver, or a class the uploader supplies as it does
for the scope sweeper) is still open.

### 5.4 Inference

Until [#1073](https://github.com/substrat-run/substrat/issues/1073) lands, the host uses the
existing model host (governance around one call: platform-held credentials, a `guard`, priced
usage line). That is a **known, temporary** limitation: the vertical's worker still holds the
capability. The design must not depend on it. When inference moves to the control plane, the
host calls it through the relay #1073 describes, and nothing above changes. Streaming through
that relay is the genuinely new design work; #1073 says outright that it "is not designed".

Route by task: a small, fast model for classification, small talk and context summarisation;
the larger model for the tool loop. AI Gateway's Auto Router or dynamic routing may do this
without code; evaluate before building our own.

### 5.5 The UI: client, element, wrapper

Three layers, the first being the one that matters most:

1. **`assistant-client`** (headless): connection, resume, message tree state, optimistic send,
   approvals, derived UI state (idle, thinking, streaming, awaiting-approval, handed-off,
   offline). Framework-free TypeScript. A mobile app or a bespoke chat tab uses this directly.
2. **`<substrat-assistant>`**, a custom element over the client. One artifact serves the
   in-app case and the embedded case (ticket0's widget today). Shadow DOM isolates it from
   host CSS; CSS custom properties from the vertical's tokens theme it.
3. **A thin React wrapper.** React 19 passes props and events to custom elements, so the
   wrapper exists for typed events and ergonomics, not for correctness.

**Tooling: Lit**, unless the set of components outgrows it. Stencil's strength is generated
Angular/Vue/React wrappers and lazy loading for large sets; with two to four components and
consumers that are React apps and a script-tag embed, it adds a toolchain and generated
files that each need the repo's three generated-file marks. Switching later rewrites a thin
shell, not the product, because the logic is in the client.

**Rich results.** A workout card or a customer summary needs a vertical's own rendering.
Provide a renderer registry keyed by tool name, and named slots. The default renderer is a
labelled table or key-value list, so nothing is blank without a custom one. Third-party
runtime UI extensions remain out of scope ([#1671](https://github.com/substrat-run/substrat/issues/1671),
K-15); these renderers are first-party and build-time.

**Platform components beyond the assistant.** The account menu with avatar, a notifications
bell and the impersonation strip are platform-owned in the same sense. The rule for a shared
component: the platform owns its behaviour end to end **and** two verticals need it. The
assistant and the account menu qualify now; build the assistant first, extract what the two
share, and record K-15's boundary in a short decision so this is not read as a precedent for
third-party extensions.

Licence: `packages/ui` is AGPL and private. An element embedded in a customer's page, or
imported by a builder's vertical, cannot be. §16 Q8.

### 5.6 The support handoff

A contract, not a ticket0 feature. The product's assistant opens a support conversation with
a summary, receives human replies, and closes it. ticket0 is the first implementation; a
different desk could sit behind the same contract later, but we build for one until a second
exists.

- **Mirror, don't merge.** The thread stays in the product. ticket0 gets a conversation with
  the summary and a link back; its agent's replies post into the user's thread as a
  `human-agent` participant. ticket0's own customer conversations (email, widget, portal)
  keep their model; the in-app chat becomes one more channel into the same desk.
- **What crosses is chosen by the user.** The desk is the platform's tenant, not the
  customer's, and tool results can contain the customer's own records. The handoff carries
  a **summary the user can read and edit before it is sent**, plus a link, never the raw
  transcript with tool payloads. The `handoff` row stores exactly what was shown and when
  consent was given. Without this, "talk to support" quietly becomes "send my customers'
  records to the vendor".
- **Transport:** the widget API or a cross-vertical event ([#1705](https://github.com/substrat-run/substrat/issues/1705))
  outbound, and an inbound message path. New work, designed in P5.
- **Who writes into the user's thread, under what.** A desk agent's reply is posted into the
  product's scope by the product's own inbound handler, as a `human-agent` participant whose
  identity is the desk's and whose authority there is one declared operation (post a reply to
  a thread with an open handoff), not any role in the customer's scope. The handoff row is
  the grant: it names the thread, the desk and its expiry, and closing the handoff ends it.
  This is a boundary crossing, and §6.3 lists it as one.
- **Delegated reads the other way** ([#1824](https://github.com/substrat-run/substrat/issues/1824)):
  #1824 is one app's assistant calling *another app's MCP endpoint* as the end user, through
  token exchange (`demos/auth-server/src/token-exchange.ts`). Part 1, the exchange, is built.
  The part this would rely on is not: the exchanged token carries `act`, but "nothing here
  reads either to allow anything", so until the host enforces an actor ceiling (#1824 part 2)
  an exchanged token is checked like any bearer for that user, with the user's full role. A
  desk reading a user's diagnostic state would also need an MCP surface on the product it
  reads, which the dashboard does not have (§12.1). So this waits for §6.0's prerequisites,
  is **read-only** when it comes, and never writes on the control plane. Writes happen in the
  product's own assistant, with the user watching.

## 6. Authority and safety

### 6.0 Who acts: the user and the actor

The first draft had the loop call every operation as the signed-in user's principal. To the
kernel, a write the model proposed and the user's own click were then the same call. Three
things follow from that, and each is disqualifying on its own: "the approver must be the user,
not the AI" cannot be enforced, because any route the user's credential reaches the loop's
credential reaches too; history credits the user with writes the model chose; and the
assistant can never be held below the user's role. The repository already has the pattern
that answers this: K-42 (a second actor stamped by the kernel, out of reach of module code),
#1824's `sub`/`act` model (the user's permissions intersected with an actor ceiling), and
ticket0's own assistant, which runs under its own `assistant` and `assistant-autonomous` roles
so that a grant, not the code, decides whether an answer reaches a customer
(`demos/ticket0/src/provision.ts`).

The rule, in seven points:

1. **Two identities on every call.** The subject (the user) and the actor (the assistant,
   identified by its thread and persona) are stamped by the host or the kernel, never supplied
   by the loop's own arguments. The model is K-42: the actor is absent from `DomainEventInput`
   and from `ctx`, so module code can neither claim it nor drop it nor branch on it, and it is
   recorded on the K-34 envelope, the K-35 denial row and the platform-intent journal.
2. **Authority is the user's permissions intersected with the actor's ceiling, checked by the
   host on every invoke.** The ceiling is a set of scope permission keys, like ticket0's
   `assistant` role, so unlike K-42's staff actor the intersection is not empty by
   construction. A tenant admin can narrow the ceiling; nothing widens it past the user. Where
   a ceiling is read-only, it is enforced as K-42 enforces read-only: the transaction is rolled
   back, not trusted to the effecting verbs.
3. **An approval is the user's act, not the loop's.** It arrives on a user-presence route that
   is never offered as a tool and that the loop's credential cannot call. It binds the
   approving principal, the thread, the call (and the step it belongs to), the operation, and a
   digest of the input in a tagged, canonical encoding, plus an expiry and a nonce. It is
   single-use, and that is enforced by the record's own conditional append, not by a read that
   comes before it. An approval over a WebSocket is authenticated as the user on that message,
   not inherited from the socket's opening. A digest of the input alone is not enough: the
   same `{ id }` then gives one digest for an archive and a delete, and for one call in two
   threads (the gap found in the contracts draft, #2304). So the digest hashes a tagged tuple,
   as the contract implements it:
   `['substrat.approval/v1', version, approver, thread, step, call, operation, expiresAt, nonce, input]`,
   where `version` is the deployed version the request was made under, `expiresAt` an ISO
   instant as `toISOString()` writes it, and `nonce` 16 to 64 characters of `[0-9A-Za-z_-]`.
   The encoding is its own (`approvalEncoding` in `@substrat-run/contracts/assistant-stream`),
   not the idempotency fingerprint's, refuses values JSON cannot carry, and its vectors are
   pinned in the contracts test (`packages/contracts/test/assistant-stream.test.ts`); and the `approval-resolved` stream event and the
   record's row name the approver and echo the digest. The kernel event about the approval
   does not carry the digest, since the input can hold personal data (§5.2). Digests are stored and compared across deploys, so this is settled
   before the schema is published, not after. An approval can also wait across a deploy that
   changes the operation or its `preview`, and the user approved what the old `preview`
   showed. So the tuple includes the deployed version the request was made under, and an
   approval given under another version is refused; the pending request is shown again.
4. **Authority is re-derived each step** from a live credential, and it ends when that
   credential does. For a vertical that is `AuthSubject.expiresAt`, as anything held open past a
   request already is (`packages/vertical-auth/src/provider.ts`, #938); for the dashboard in P1
   it is the session its request carries, resolved by the same `resolveAccount` its routes
   call. **A step with no request has no credential, so it calls no tool.** The object's alarm
   (§5.3) may end a turn in a defined state, or finish a model step that calls no tool; a tool
   step waits until a client with a live session attaches, and resumes from the record. The
   other answer, a thread that stores a session reference and re-validates it each step, would
   make the thread object a credential holder; it is not proposed here (§16 Q11).
5. **Revocation mid-run stops the run.** A role revoked, a session ended or the assistant
   switched off takes effect at the next step. The run ends in a defined state (§10, "permission
   denied"); it does not finish on authority it no longer has.
6. **History shows who acted.** `readHistory` returns subject and actor, so an AI-proposed write
   reads as "the assistant, for this user, approved by this user", and a write the user made
   by hand reads as the user's alone.
7. **Until the host can do this, nothing the assistant calls writes.** P1 is read-only, and
   P2's gated write waits for the prerequisites below.

**What this RFC decides, and what it only proposes.** Points 1 to 7 are this RFC's
requirements: no assistant write runs on the user's bare principal, an approval is never a
tool, an approval carries the bindings in point 3, and authority is per step, expiring and
revocable. The mechanisms are **proposed prerequisites**, not built and not decided here:

- (a) **the host-side ceiling and `act` on the authorization chain**, which is #1824 part 2,
  with [#121](https://github.com/substrat-run/substrat/issues/121) (scopes as a ceiling)
  related;
- (b) **a kernel or host actor stamp for an actor that is not an impersonating staff
  member**: K-42's mechanism generalised, including its read-only rollback, which today is
  tied to an impersonation session and is what a `read` tool would run under (§6.1). Whether
  that amends K-42 or is a decision of its own is the maintainer's call;
- (c) **a `ScopeStub` read of a principal's keys**, needed only if the offered list is ever
  filtered per user (§6.1, §6.4).

**Proposed, maintainer to confirm (§16 Q11):** the default ceiling is one platform-defined
ceiling per vertical under a reserved key (a working name is `substrat:assistant-ceiling`; the
name is not decided), declared beside the vertical's roles so it appears in `PERMISSIONS.md`,
which a tenant admin can narrow. It is not a role any principal holds, so it cannot collide
with a vertical's own role keys: ticket0's `assistant` and `assistant-autonomous` are roles
its assistant's *own* principal holds, a different thing that P5 keeps. And for P1, whose tools are dashboard
routes rather than scope operations (§12.1), the actor is recorded on the dashboard's own
request record (thread and persona beside the user) until the control plane can carry it. That
is a known gap, stated rather than hidden: on that path the control plane records the platform
service actor with the person beside it as `onBehalfOf` (#977, PR #1943), and has no slot for
an assistant.

### 6.1 The rule

Tools are the vertical's operations. The host invokes each for the signed-in user with the
assistant as actor (§6.0), so the user's role is the upper bound and the assistant's ceiling
can hold it lower. A call outside either is refused by the host or by the operation itself and
comes back in-band for the model to read, as it does over MCP today. ticket0 is the in-repo
evidence that an assistant needs a permission model of its own: the difference between its
supervised and autonomous assistant is one permission key.

What the model is **offered** is the set of operations declared `assistant.expose`, which is a
curation decision made per operation in the model and reviewed in the PR. Narrowing that set
further by what *this* user may call would be a least-privilege floor and would shrink the
prompt, but it needs a read of a principal's grants that `ScopeStub` does not have today
(§4.1, prerequisite (c) in §6.0). It is worth adding for a narrow role (a customer or a
trainee) and buys little for an admin; it is an open item, not something this design assumes.

An operation opts in, in the model:

```ts
// illustrative sketch of an operation declaration, not a decided API
assistant: {
  expose: true,
  effect: 'read' | 'write' | 'irreversible',   // fails closed: see below
  label: 'Log a set',                            // human wording shown in the UI
  preview: (input) => ({ ... }),                 // what the approval card shows
  undo: 'ops/unlog-set',                         // optional; makes a write reversible
}
```

Reads run without a prompt. Writes show a **preview card** (what will change, in the user's
words) and need approval. Irreversible operations always need a preview and an approval. The
default for an exposed write with no declaration is **approve first**; loosening is explicit
and reviewed.

**The effect class fails closed.** An operation with no `effect` is a `write`, whatever its
HTTP method. `read` is a claim, and it holds only where something enforces it: the
`readOnlyHint` that `mcp.ts` derives from the method is a hint to a client, not a guarantee.
So a tool declared `read` runs under a read-only rollback like K-42's, and a handler that
writes is rolled back rather than trusted. K-42's rollback is tied to an impersonation session
today; using it for an assistant actor is part of prerequisite (b) in §6.0. (On the dashboard, where the tools are routes and not scope
operations, "read-only" is a property of the tool list, not a mechanism; §12.1.)

**`undo` relaxes the prompt only where nothing has left.** A write with a declared `undo` may
run and show an undo control instead of asking first, which the research suggests is the
right trade for low-stakes, reversible changes. But a write emits a fat event, and consumers
act on it (a connector, the notifications engine sending mail), and an undo operation calls
none of that back. So "reversible" means: nothing consumes the operation's events and it
requests no outbound effect. Most of that cannot be read from a declaration today. Events a
composed engine emits from inside the operation are not on the operation's own `emits`, an
exported event (#1705) is consumed by another vertical that no manifest here names, and no
declaration says which outbound effects an operation can request. So the rule fails closed:

- **No declaration, no `undo`.** Until an operation can declare its outbound effects, an
  exposed write needs approval, whatever its `undo`.
- **After that, an allowlist the reviewer reads.** `undo` applies only to an operation listed
  in the assistant-reach section of `PERMISSIONS.md`, so widening it appears in the PR diff.
  The gate refuses an entry for an operation that emits an exported type, whose event types a
  composed manifest consumes, or that declares an outbound effect. Whether it calls an engine
  function is not visible to the gate, so the entry states it and the reviewer checks it.
- **Never in a tainted context.** `undo` never skips approval while untrusted text is in the
  model's input (§6.3), which in practice means rarely.

### 6.2 The permission-diff checkpoint covers the assistant

`PERMISSIONS.md` already renders what each role can do. It gains an **assistant reach**
section: for each role, the exposed operations, their effect class, and which of them the
assistant's ceiling (§6.0) leaves it able to call. Widening what the
assistant can do then appears in the PR diff and cannot merge unseen, which is the
repository's existing answer to "agents never self-approve". This is a new human checkpoint
by extension, not a new mechanism.

### 6.3 Prompt injection, per consumer

| Consumer | Untrusted text the model will read | Consequential tools | Posture |
|---|---|---|---|
| Training-plan app | Mostly the user's own input | Edit a plan, log sets | Low risk; approve writes anyway |
| Internal CRM | Customer-authored notes, imported fields, inbound email | Edit or delete records, send mail | **Highest risk.** Writes approve-always; no tool that sends externally without approval; never let one turn both read an untrusted field and write on its basis without a human step |
| ticket0 | Anything a visitor types or a KB article contains | Handoff, reply | Replies are drafts or constrained answers; no data tools beyond the asker's own |
| Dashboard | Log lines and error messages from tenants' code: customer data, and untrusted | Roll back, redeploy (later) | Read-only in the first release (§12.1): no outward links or images, no tools that write. The text goes to a model provider, so §16 Q13 is a P1 prerequisite |
| Any consumer with attachments | Text extracted from an uploaded file (K-43), and files from a connected source (the file-bearing sources RFC, #2280) | Whatever the consumer exposes | Attachment text is untrusted whoever uploaded it; it is a read result like any other and taints the turn |

Design rules, all structural:

- **Every read result is untrusted by default, and taint is a property of the model's input,
  not of the turn.** The rule below needs the host to know which text is untrusted, and no
  declaration says so today. The fail-closed answer is to treat every tool result as
  untrusted, and to call a step tainted when its input (§7) still holds any of: a tool result,
  verbatim or not yet cleared; a summary derived from a context that held one; a memory item
  whose source is not a message the user wrote; or a "where the user is" line that carries a
  field someone else wrote (an entity's title). A tainted step's writes all need approval,
  whatever their `undo`. So an instruction read in one turn ("when the user next says ok,
  archive this customer") cannot drive a write in the next, because the text it came in is
  still in the input. A later declaration may mark an output field as trusted (a status enum,
  a number the operation computed); the default never changes. The consequence is stated
  plainly: in a thread that has read anything, `undo` almost never removes a prompt.
- **Context the host re-injects is data, never instructions.** Memory (§7 layer 3) and "where
  the user is" (layer 4) can carry text someone else wrote: an entity title, a memory chip
  proposed after a turn that read untrusted content. Both are passed to the model in a data
  block, marked as such, and never in the standing instructions, and both count toward taint
  as the rule above says.
- **Approve-always for writes where untrusted text is in context.** The approval card shows
  *our* description of the action (from `preview`), not the model's prose, so injected text
  cannot rewrite what the user is approving.
- **Quarantine large untrusted fields.** When a note or message must be summarised, a call
  with no tools does it, and its output is passed on as data. (The CaMeL idea, applied
  narrowly.)
- **No outward channel the model controls.** Markdown images and links are the classic
  exfiltration route. The renderer drops remote images and shows link targets, or routes them
  through an allowlist. Tools never take a free-form URL to fetch.
- **The model never picks the tenant or the scope.** A thread is pinned to one scope (and, on
  the dashboard, one team) when it is created; a user who belongs to several tenants (K-22)
  gets a thread per tenant, and nothing the model writes into a tool's arguments can move it.
  That makes an ordinary tool call stay inside one scope. It does not make crossing
  impossible, because three planned paths cross on purpose, and each names who writes and
  under what:
  - **The handoff** (§5.6) moves a user-approved summary to the platform's tenant, and the desk
    posts into the customer's thread through one declared operation, granted by the open
    handoff row.
  - **Delegated reads** (#1824) cross apps as the user, under the exchanged token's grant, and
    wait for the ceiling in §6.0.
  - **A cross-scope read** (#2279) exposed as a tool reaches several scopes in one call. It is
    declared and checked per scope by the host, and exposing one to the assistant is its own
    review, since its result mixes data from scopes the thread is not pinned to.
- **Defence in depth:** AI Gateway guardrails and DLP on the way in and out. Useful, never the
  control.

### 6.4 What testing must prove

Mechanical, not hoped for (§11): a call to an operation outside the user's role, or outside
the assistant's ceiling, is refused in-band even when the model was offered it (the offered
list is `assistant.expose` and is not filtered per user, §6.1); an injected instruction in a
fixture note produces no write without approval; an approved call with altered arguments, or
an approval replayed, expired, given for another thread, or sent with the loop's credential,
is refused; a role revoked mid-run stops the next step; history shows the actor beside the
user; a budget-exhausted user gets the defined message, not a stack trace.

## 7. Context

Each turn the host **assembles** the model's input; it is not "the whole thread". Layers, in
this order, because order decides whether the prompt cache hits:

1. **Standing instructions** (persona, rules, locale, the effect-class policy). Pinned. Never
   summarised, never dropped, re-injected every turn so compaction cannot erase them.
2. **Tool definitions:** the offered set (§6.1), stable within a session, so cacheable.
3. **Memory** (§8): the small set of active items, not a search result. Passed as data, never
   as instructions (§6.3).
4. **Where the user is.** The vertical supplies a function from the current route and entity
   to a few lines: "viewing order 123, status open". This is what makes the assistant feel
   like part of the app, and it is cheap. Shown to the user as a context chip they can remove.
   An entity's title is text someone else may have written, so this layer is data too.
5. **Retrieved knowledge** (KB, docs) when the persona has a search tool.
6. **Thread history:** recent turns verbatim, older turns as a running summary.
7. **Tool results** for the current turn.

Policies:

- **Clear before you summarise.** Old tool results are replaced by a placeholder (the call
  stays, the content can be re-fetched). Only then summarise the dialogue. Clearing costs no
  inference; summarising does.
- **Summarise as an overlay**, as `Think` does: the original messages stay in the record, the
  summary is what the model sees. The summary prompt is ours and states what must survive
  (decisions, open questions, the user's stated constraints).
- **Compact at a natural boundary** (a goal finished, abandoned or revised), with a token
  threshold as the backstop.
- **Cache-friendly:** stable prefix first, volatile content last, and do not clear tool
  results in a way that invalidates the prefix unless the saving is large (clear in batches).
- **The window is a budget per layer**, enforced in the host and visible in the trace, so a
  runaway tool result cannot starve the standing instructions.

## 8. What we store about the user

The principle: **remember the least that makes the product noticeably better, make it visible,
and make deletion real.**

### 8.1 Tiers

| Tier | What | Default retention | Where |
|---|---|---|---|
| Transcript | The thread's messages and tool trace (digests and references, not payloads) | Product-configurable; propose 90 days after last activity, then archive or erase | Scope, `engine-assistant` |
| Thread summary | The running summary and a title | Same as the thread | Same |
| **User memory** | Small, atomic, explicit facts: goals, constraints, preferences, stable facts the user stated | Until the user removes it, or its expiry | Scope, `memory_item` |
| Derived analytics | Counts, latencies, costs, thumbs up or down | Aggregated, no content | Platform telemetry |
| **Never stored** | Raw tool payloads, passwords, payment data, anything the persona is told not to keep | n/a | n/a |

### 8.2 Memory rules

1. **A memory is a statement with a source.** Each item points to the message it came from,
   carries a kind, a confidence and an optional expiry, and is subject-keyed to the user.
2. **How it gets written.** Explicit statements ("I have a bad left knee", "call me Sam") can
   be proposed by the assistant as a **visible chip**: "Remember: bad left knee?" with
   Accept, Edit, Dismiss. Silent writing is off by default. A product may allow auto-save for
   a defined, non-sensitive kind (a name, a preferred unit) and no others.
3. **The app decides the policy; the platform sets a floor.** Each product declares its memory
   mode in `spec/assistant.ts`: `off`, `opt-in` (the default) or `opt-out`, and which memory
   kinds exist. The user always has the per-user switch and the list, whatever the mode. The
   floor the platform enforces: a kind marked sensitive cannot be `opt-out`. A training coach
   will hear about injuries and health, which is special-category data under GDPR Article 9
   and needs an explicit basis, so that product declares `opt-in` with a plain-language
   explanation. A CRM that remembers a staff member's preferred report layout can reasonably
   choose differently.
4. **The user can see all of it.** A "What I know about you" view in the component: every item,
   its source, edit and delete. Deleting an item deletes the row; the assistant is told on the
   next turn not to rely on it.
5. **Delete means delete, including what was derived.** Removing a source message removes the
   memory items derived from it, or re-derives the thread summary without it. If a vector
   index is ever added, a delete removes the vector with the row. Suppress-only is not offered
   as deletion.
6. **Verify before acting.** A memory is context, not truth. For anything the app can look up
   (a plan, an order), the assistant reads the current value rather than quoting memory.
7. **Memory is per product and per user.** No cross-product memory, no platform-wide profile,
   and nothing is used to train a model.
8. **Subject erasure reaches it.** `memory_item` and message text declare their erasable
   fields in the model, so the kernel's subject-erasure path
   ([K-37](../decisions/K-037-subject-erasure-splits-by-store-tier-1-is-redacted-platform-.md),
   [K-46](../decisions/K-046-subject-erasure-reaches-a-module-s-own-tables-by-declaration-or.md))
   covers them like any other module table. Because K-46 keeps an `erasable` field off every
   event, message and memory text never rides an event payload (§5.2), and neither does a
   digest of it: the events carry ids, participants and part kinds, so the fact of the event
   survives an erasure with nothing in it to shred, and no Tier 2 copy of the text, or of
   something that confirms it, exists to chase. The digests live on the rows K-46 erases.
9. **Memory is exportable** with the rest of a user's data.

### 8.3 What not to build yet

No vector memory, no automatic profile inference, no cross-session semantic recall in v1.
A short list of explicit items the user can read covers most of the value and is the only
version whose deletion semantics are easy to state truthfully.

## 9. Cost and limits

- **Before the call:** the model host's `guard` checks a per-user budget, and that check is the
  authoritative cap. The platform adds an AI Gateway spend limit scoped by user (custom
  metadata) as defence in depth: it bounds how far a bug in the vertical's own check can
  overspend, but spend limits are eventually consistent, so a burst can pass it briefly. It is
  a backstop with an overshoot, not a hard cap.
- **Per turn:** a step bound, a cap on output tokens, a cap on tool-result size entering
  context.
- **Per user:** `engine-metering` (already composed by ticket0) records usage; a daily budget
  produces a defined, friendly message when reached, not an error.
- **Per thread:** a maximum thread length before the assistant offers to start a fresh one
  with a carried summary.
- **Abuse:** rate limit per user and per tenant; AI Gateway guardrails for content.
- **Visibility:** the tenant admin sees usage; a user is never surprised by a bill they did not
  know existed.

## 10. The experience: what "perfect" is checked against

This is the acceptance list. Each item is testable, and a release that fails one does not ship.
Numbers are **targets to validate in the spike, not measurements.**

**Speed and feel**
- Time to first visible token feels immediate: target p50 under 1.5 s on a warm thread, with
  an acknowledgement (typing indicator or the first tool step) under 300 ms.
- Streaming never reflows earlier text; incomplete markdown is buffered, not shown broken.
- Auto-scroll only while the user is at the bottom; "Jump to latest" otherwise.
- The input stays usable while the model works; Enter sends, Shift+Enter breaks a line; IME
  composition never sends early.

**Control**
- **Stop** is always visible during generation and keeps what was written.
- Retry (after an error) and Regenerate (after a bad answer) are distinct. Regenerations and
  edits create **branches** the user can step through; nothing is silently overwritten.
- Edit the last message and resend.

**Honesty about what it is doing**
- Tool steps appear by human name ("Looking up your last four sessions") while running, and
  collapse to a one-line trace afterwards. No raw chain-of-thought streamed by default.
- Every consequential action shows a **preview card** from the operation's `preview`, with
  Approve, Edit, Cancel. Reversible actions show **Undo** after they run.
- Answers drawn from the knowledge base or data carry citations or a link to the record.
- An "AI" marker, and for the dashboard the provenance block (#1749).

**Failure is designed**
- A defined state for each of: offline, reconnecting (resumes mid-stream), model error,
  budget reached, permission denied, tool failed, rate limited. Each says what happened and
  what to do next, in the user's language. None shows a stack trace or a spinner that never
  ends.
- A reload mid-answer resumes the answer.

**Start and context**
- An empty state with suggestions **derived from where the user is and what they have**, not
  generic examples. A visible context chip showing what the assistant can see right now.
- Clear first-use explanation of memory (§8) with the opt-in.

**People**
- When a person joins, the UI says so ("Sam from support has joined"), shows who is typing,
  and the transcript marks who wrote what.
- If the chat is closed when a reply arrives, the user is notified through the notifications
  engine, and opening the app lands on the thread.

**Accessibility**
- Streaming tokens are **not** announced; one completion announcement per successful turn;
  tool prompts and approvals are announced as discrete events; the transcript is a labelled
  log region, not a live region. All controls keyboard-operable with visible focus; focus
  management on open, close and approval; labels that describe purpose; reduced-motion and
  forced-colours respected; contrast in both themes.
- Verified with a real screen reader on each major platform before release. The guidance in
  §3.5 is practitioner advice and disagrees with itself in places.

**Language**
- The apps in this family are used in Swedish and English. The assistant follows the user's
  locale for its replies and UI strings, and a persona states a default language.

**Mobile**
- Usable one-handed on a small screen, keyboard-aware layout, safe-area insets, no hover-only
  controls.

**Weight**
- A bundle budget for the element (set in the spike; it loads lazily and does not delay the
  host app's first paint).

**How it is checked.** A scripted acceptance run (as `docs/acceptance/` does for other
features) covering: a flaky network, a very long thread, a screen reader, a phone, a denied
permission, an injected instruction, a budget cut-off, a handoff and a return. The run is
repeated for each new consumer.

## 11. The developer experience

The measure: **a vertical author adds a working assistant in under half an hour** and can
trust it without reading the loop. Also a target to validate.

What they write:

1. Mark operations in `spec/model.ts` with `assistant: { … }` (§6.1). Most reads need only
   `expose: true`.
2. Add `engine-assistant` to `MODULES` and register it in `provision`.
3. Add a small `spec/assistant.ts` with the persona, the locale default, the
   "where the user is" function, memory kinds, and the budget.
4. Mount the host (`mountAssistant`) beside `mountMcp`.
5. Drop `<substrat-assistant>` (or the React wrapper) into the app and set the theme tokens.

What they get without writing it:

- Tools derived from operations, with permissions, labels and previews.
- Streaming, resume, approvals, the message tree, context assembly, compaction, budgets,
  metering, the handoff.
- A generated `assistant` manifest checked with `--check` in CI (the three marks), so the
  tool surface a reviewer reads is the one that ships.
- **A test driver.** `assistantScenario()` plays a scripted conversation against a **fake
  model that returns scripted tool calls**, so a vertical's tests assert *which operations
  would be called, as whom, with what approval*, not the model's prose. It runs in the same
  suite as the vertical's other scenarios and needs no network.
- **Gates that refuse:** every exposed write has a `preview`; no exposed operation lacks a
  permission; the assistant-reach table matches `PERMISSIONS.md`; no persona asks for a tool
  the user's role does not hold without saying so.
- **Evals.** A small fixed set per vertical (representative questions, injection fixtures,
  budget and permission cases) run before and after any prompt, model or tool change, as the
  builder already does for its skills. Results are compared, not eyeballed.
- **A local mode** with a dev model so the UI can be built and demonstrated offline.

Honest cost: an extra declaration on each exposed operation, and a persona to write and
evaluate. That is the point of the design; the rest is not their problem.

## 12. Consumers and order

The order is chosen so each step tests whether the shared part is really shared, and so the
first steps are ones we control end to end.

| Order | Consumer | Why here | What it proves |
|---|---|---|---|
| 1 | **Dashboard, read-only** | Ours: no cross-repo release, no special-category data. Not free of customer data: tenants' log lines and error messages are its input (§6.3), so the model-provider position (§16 Q13) comes first. Platform code, so it may hold the model binding itself and does not wait for #1073's relay. The material to explain already exists as code | The loop, the protocol, resume, the element, provenance (#1749), cost control, the §10 acceptance run, and the deployed P0b measurements |
| 2 | **`demos/todo`** | In-repo, declared operations, sharing and revoke | The path the dashboard cannot test: `assistant.expose`, the assistant-reach section of `PERMISSIONS.md`, the scenario driver, the approval flow with a digest-bound gated write |
| 3 | Training-plan app | Owned end to end, simple permissions, MCP already works, the clearest "coach" experience. First consumer outside this repo, so the first release cycle | Memory with special-category data; a persona that is not an operator tool |
| 4 | Internal CRM | Staff users, audit matters, highest injection risk | Approve-always writes, quarantine, the audit trail as a feature |
| 5 | ticket0 | Retrieval-first rather than operation-first; has a human side | That the loop is not secretly operation-only; the handoff contract |

### 12.1 Why the dashboard first, and what it does not prove

What the dashboard is today, read for this section: it is itself a module on a real `ScopeDO`
(`dashboardModule`), it already declares its own Durable Object classes (for example
`GithubRepoLinkDO`), its service binding reaches the control plane, and it has **no AI binding,
no model code and no MCP mount**. Its operations are `undeclaredOperations`: it "declares no
operation surface; its handlers parse their own input". The data a first assistant would
explain already exists as code (`fleet-health.ts`, `failure-groups.ts`, `flow-findings.ts`,
`app-metrics.ts`, `deployments.ts`).

What that buys:

- **No release cycle across repositories,** and no health data in play. Tenants' log lines and
  error messages are in play, and they are customer data (§6.3).
- **#1073's concern does not apply.** That issue is about a *pushed vertical* holding the model
  capability. The dashboard is platform code, so it holds the model binding itself, with the
  platform's own metering and a per-user budget. #1073 stays the path for verticals (P6).
- **Two open questions get cheap answers.** The element ships inside the dashboard's own web
  app, so its licence and package home (Q8) can wait. The dashboard declares its own Durable
  Object classes, so "how is a vertical given the thread object" (Q2, the second half) can wait.
- **The deployed measurements (P0b) ride on it.** A preview deploy of the thread object, with
  a real model, is how the 30 s `waitUntil` cap, eviction, first-token time and idle cost get
  measured, instead of a separate exercise.

**How a dashboard tool is authorized, which is not how §6.1 describes a vertical's.** The
dashboard's reads are Hono routes in `apps/dashboard/src/worker.ts`, not scope operations,
and no `assertAllowed` stands in front of them. Take `/api/deployments/:slug/issues`: it
resolves the account from the session and team cookies (`resolveAccount`), takes a control
plane narrowed to that tenant by a tenant token, and checks ownership of the slug
(`assertOwnedFromCp`); only then does it call the pure `deriveFailureGroups`, which checks
nothing. So for P1:

- **A dashboard tool calls the same guarded function its route calls, or the route itself,**
  never the bare `derive*` helper. A wrapper that repeats each guard by hand is how one gets
  forgotten; the P1 suite asserts, per tool, that a slug the team does not own is refused.
- **The team is fixed when the thread is created.** The team a request reads is chosen per
  request by the team cookie, so a thread records its team and every step resolves against
  that team, not against whatever the cookie says now. A user who switches team gets a
  different thread (§6.3). The guard needs the session and team cookies, so a step the thread
  object runs from its alarm, with no request, calls no tool: it may end the turn or finish a
  model step, and a tool step waits for the user's next request (§6.0 point 4). The P1 run
  ends when the dashboard session does.
- **Attribution is weaker on this path, and that is stated.** The control plane records these
  calls as the platform service actor with the person beside it as `onBehalfOf` (#977). It has
  no slot for an assistant, so P1 records the actor on the dashboard's own request record
  (§6.0, Q11).
- **"Read-only" is a property of the tool list here, not a mechanism.** K-42's rollback applies
  to a scope's transaction; control-plane reads are HTTP calls, and nothing would roll one
  back. P1 offers no tool that maps to a writing route, and the P1 suite asserts the list.

What it does **not** prove, which is why `demos/todo` follows immediately and is not optional:
the dashboard's tools are **hand-written wrappers over those guarded reads**, not derived
from declarations. So the dashboard cannot exercise `assistant.expose`, the generated tool
manifest and its `--check`, the assistant-reach section of `PERMISSIONS.md`, or the gates that
refuse an exposed write with no `preview`. Those are the parts with the most new mechanism and
the most risk, and a dashboard-only first release would leave them untested.

Scope of the dashboard's first release: **read-only.** ⌘K Ask and "explain this finding" (the
first two uses #1749 describes), always with the AI marker and the provenance block; the
"query it ran" block is hidden from tenant admins, as #1749 states. Writes (roll back,
redeploy) wait for the approval path to be proven on `demos/todo` (P6).

Open, not yet read: **where a dashboard thread's record lives.** The dashboard's tenancy is
team = tenant with scopes per team (the multi-team model); whether a thread belongs to the
user's scope, the team's, or a per-user store is a decision for P1, and it decides who can see
a thread and what erasing a member removes.

**ticket0 already has an assistant**, and P5 is a migration, not a new consumer.
`demos/ticket0/harness/assistant.ts` runs through the platform's model host under
`waitUntil`, records through `ticket0/record-answer`, and comes out `answered` or `drafted`
depending on whether its role holds the public-reply key (`assistant` versus
`assistant-autonomous` in `src/provision.ts`). That supervised/autonomous policy is a
precedent for the ceiling of §6.0, not the same thing: ticket0's assistant answers as its own
principal under a role, so there is a ceiling but no user to intersect it with. Moving ticket0
onto the shared loop must keep the policy. ticket0 becomes a **consumer** of the shared loop, with a persona, a
KB-search tool and a handoff tool, and keeps its own conversation model (customer and agent,
statuses, assignees, SLAs, snooze). It is not replaced. Its AI-authored messages link to an assistant
thread for the reasoning and tool trace, by id, so the star topology holds: the vertical
composes both, and the two engines never import each other.

Two of these live outside this repository. Adopting the assistant there means a release of
the host and engine packages, a version bump in each app, and a re-push, so the release cycle
is the real critical path.

## 13. Observability and quality

- **Per turn:** time to first token, total time, steps, tool calls and outcomes, tokens,
  cost, model, whether a budget or permission limit applied. Written to the request record
  and the model-usage ledger, attributed by user and thread.
- **Per thread:** outcome (answered, acted, handed off, abandoned), and a thumbs up or down with
  an optional reason. Abandonment after a failure is the signal most worth watching.
- **Provenance** in the UI and in the record: which sources, which operations, which model.
- **Evals in CI** (§11) and a **review queue** of low-rated threads for the product team,
  respecting §8 (a reviewer sees what the retention policy allows, and the user is told that
  low-rated threads may be reviewed).

## 14. What this RFC deliberately does not do

- **Autonomous background agents.** v1 acts only inside a turn the user started.
- **Third-party or runtime-installed UI extensions** ([#1671](https://github.com/substrat-run/substrat/issues/1671)).
- **Voice.** The protocol leaves room for it; it is not in scope.
- **Vector or semantic memory**, automatic profile inference, cross-product memory (§8.3).
- **Hosting our own models.** Providers sit behind the model-providers table.
- **A general component framework.** Two platform components (the assistant and the account
  menu) and a rule for adding a third, not a framework.
- **Replacing ticket0.**

## 15. What I could not verify

- **`mountMcp`'s invocation path** was read end to end in P0 and §4.1 is corrected from it.
  Not yet checked: the cost of a real `stub.invoke` of an engine operation (permission check,
  events, outbox) against the spike's raw log append, which is the P0b measurement.
- **ticket0's conversation entities.** I did not read `spec/model.ts` for how a mirrored thread
  maps onto them; the mirror design depends on it.
- **The dashboard facts in §12.1** were read from `apps/dashboard` (its module, wrangler
  bindings, one route's guards, and the absence of model and MCP code; `mcp-resources.ts`
  registers verticals' MCP endpoints at issuers and mounts nothing), not run. Where a thread's record lives for
  a team-scoped product is not decided.
- **Scope-store fit.** I read the opening of [scope-stores.md](scope-stores.md) only.
- **Library versions and sizes.** I did not pin an `ai` major, measure Lit's or Stencil's
  bundle size, or run either.
- **The MCP Apps spec identifier** differs between the sources I found (SEP number and MIME
  type), so check the official spec before implementing anything against it.
- **Legal.** I found no EDPB guidance specific to assistant memory; the retention and
  special-category points are general GDPR principles. They need review by someone qualified
  before the training-plan consumer ships.
- **Several sources are vendor blogs or preprints** (Mem0, accessibility issue threads, 2026
  arXiv papers). They inform the design; none of it rests on one of them alone.
- **Every number marked "target"** (latency, setup time) is an aspiration to measure deployed, in P0b and P1.

## 16. Decisions asked of a human

1. **Wire format.** Own a Zod schema shaped like the AI SDK's `UIMessage` parts and adapt at the
   edge (recommended), or adopt the AI SDK's types directly, or adopt AG-UI. **Working decision
   for P1: own the schema.**
2. **Where a live thread runs.** P0 (local) recommends a Durable Object per thread as the live
   coordinator over a placement-agnostic loop and record, with request plus `waitUntil` as the
   fallback shape (§5.3). **Working decision for P1: take that recommendation.** Deployed
   confirmation (P0b) happens on the dashboard's preview deploy. How the object is provided to
   a *vertical* (a scope-store driver, or a class the uploader supplies) is deferred; the
   dashboard declares its own.
3. **Engine name and scope.** `engine-assistant` (recommended, to avoid colliding with ticket0's
   own "conversation"), and whether participants and handoff belong in it or in a vertical's
   side table. **Working decision for P1: `engine-assistant`;** participants and handoff are
   decided when P5 needs them, and P1 does not build them.
4. **Memory policy.** Per-app mode (`off`, `opt-in`, `opt-out`), default `opt-in`, with a
   platform floor that a sensitive kind cannot be `opt-out` (§8.2 rule 3).
5. **Default transcript retention.** 90 days after last activity is a proposal, not a finding.
6. **Confirmation default for exposed writes.** Approve-first (recommended), with `undo`
   declared to relax it.
7. **Handoff contract.** Summary-only with user consent (recommended) versus a fuller
   transcript option for products whose users agree to it.
8. **Licence and package home** for the element and client, given `packages/ui` is AGPL and
   private and the element is embedded in pages we do not control. **Deferred:** the dashboard
   bundles it inside its own web app, so this blocks nothing until the first consumer outside
   this repository (P3).
9. **A K-15 amendment** stating that first-party, build-time platform components do not open
   the door to runtime third-party UI.
10. **Order of the consumers** in §12. **Working decision:** the dashboard first and read-only,
    then `demos/todo`. The dashboard does not wait for #1073's relay, which concerns verticals.
11. **The actor and its ceiling (§6.0).** Points 1 to 7 of §6.0 are this RFC's requirements.
    The mechanisms are proposed prerequisites: (a) the host-side ceiling and `act` on the
    authorization chain (#1824 part 2, with #121); (b) an actor stamp for a non-impersonation
    actor, K-42 generalised (its read-only rollback included), as an amendment to K-42 or a
    decision of its own; (c) a `ScopeStub` read of a principal's keys, only if the offered list
    is filtered per user. **Proposed, maintainer to confirm:** the default ceiling is one
    platform-defined ceiling per vertical under a reserved key that no role uses (working name
    `substrat:assistant-ceiling`), shown in `PERMISSIONS.md`, which a tenant admin can narrow;
    P1 records the actor on the dashboard's own request record until the control plane can
    carry it; and a step with no request (an alarm) calls no tool, rather than the thread
    holding a session reference it re-validates (§6.0 point 4).
12. **Tenant-admin control.** Today only the vertical's author decides what is exposed.
    **Proposed, maintainer to confirm:** a tenant admin can switch the assistant off for the
    tenant and narrow its ceiling (Q11), but cannot widen it past what the author exposed or
    past any user's role. Switching it off is a revocation, so a running turn stops at its
    next step (§6.0 point 5).
13. **The model provider as a sub-processor, and data residency.** Every read result in
    context goes to the model provider, including, on the dashboard, tenants' log lines. The
    platform's jurisdiction setting (`global`, `eu`, `us`; K-32) says where a tenant's data
    lives and nothing yet says where its inference runs. **Proposed, maintainer to confirm,
    and a P1 prerequisite:** the provider and its region are listed as a sub-processor before
    any tenant text reaches it; a tenant in `eu` or `us` gets an assistant only where a
    provider route in that region exists, and otherwise none, rather than a silent `global`
    one; the context sent is the fields a tool returns, bounded (§9), never whole log
    payloads; and nothing sent is retained by the provider for training. What a tool may send
    is a **field allowlist** per tool, not whatever the helper returns, and free text from
    tenants' code (log lines, error messages) passes a **redaction** step first that removes
    what looks like a secret (tokens, keys, connection strings) or personal data (email
    addresses, phone numbers) before it reaches the model; a size bound is not a redaction
    rule. The provider's **operational retention** (abuse monitoring, logs) is stated per
    provider with its deletion period, and a provider whose operational retention cannot be
    stated or turned off for this traffic is not used for tenant text.
14. **Thread visibility.** **Proposed, maintainer to confirm:** a thread is visible to its
    subject alone by default; a tenant admin may read threads only where the product declares
    it (an internal staff tool may, a coach may not), and the user is told so. Tool references
    in a thread are re-fetched as the *viewer*, never shown from what the subject saw, so a
    viewer with less access sees less. Where a dashboard thread's record lives (§12.1) is the
    P1 half of this question.
15. **`assistant.expose` and `mcp: false` (§4.1).** **Proposed, maintainer to confirm:** one
    derivation, with `expose` a filter over the MCP tool list, and a gate that refuses
    exposing an operation hidden from MCP.

## 17. Risks

| Risk | Mitigation |
|---|---|
| Injection through customer-authored text in the CRM | §6.3: approve-always writes, our preview text, quarantine, no outward channel |
| Cost runaway from a looping agent | Step bound, per-turn caps, per-user budget before the call and at the gateway |
| The abstraction is shaped by one consumer | §12 order: the dashboard (routes, not operations) then `demos/todo` (declared operations) first, and ticket0 (retrieval-first, with a human side) specifically to break an operation-only design |
| An AI-proposed write is recorded as the user's, or the assistant cannot be held below the user | §6.0: actor stamped by the host, ceiling enforced by the host, approvals bound to the approving principal; nothing writes until the prerequisites land |
| Tenant text reaches a model provider the tenant did not agree to | §16 Q13 settled before P1 sends anything |
| Wire format churn | Own the schema; adapt at the edge |
| A clunky first release teaches users not to try | §10 is a release gate, with an acceptance run per consumer |
| Memory feels creepy or is mishandled (special-category data) | Opt-in, visible list, real deletion, legal review before shipping the coach |
| Inference stays in the vertical's worker longer than intended | Design does not depend on it; #1073 stays on the path |
| The element becomes a framework by accretion | The two-consumer rule for any new platform component |

## 18. Phases

| Phase | Work | Exit |
|---|---|---|
| P0 | **Done locally** (`spikes/assistant-thread`): the loop, stream and resume on both placements, with a scripted model on local workerd | Q2 answered for correctness |
| Prerequisites | **Before P1:** the model-provider and residency position (Q13). **Before P2's gated write:** the actor stamp (§6.0 (b)), the host-side ceiling and `act` on the chain (§6.0 (a), #1824 part 2), and approvals on a user-presence route bound as §6.0 point 3 says. **Before any hosted streaming for a vertical:** #1073's relay. **Only if the offered list is filtered:** a `ScopeStub` read of a principal's keys (§6.0 (c)) | Each lands as its own change, with its own decision record where it needs one |
| P1 | **Dashboard, read-only.** `contracts` event schema; `engine-assistant`; the thread object in the dashboard worker, pinned to one team; the loop with a fake model first, then a real model through the platform's model host with a per-user budget; read tools that call the routes' guarded functions, never the bare helpers (§12.1), with the actor on the dashboard's request record; the headless client and a first `<substrat-assistant>` inside the dashboard web app; provenance. A preview deploy for **P0b**: the 30 s cap, eviction, first-token time, the real append, idle cost | ⌘K Ask answers "why is this failing" with provenance, behind a flag; the §10 acceptance run passes; the P0b numbers are written into the spike's findings |
| P2 | **`demos/todo`.** `assistant.expose` and `mountAssistant` for declared operations; the generated tool manifest with `--check`; the assistant-reach section of `PERMISSIONS.md`; `assistantScenario()` with a fake model; the first evals; a gated write with an approval bound as §6.0 point 3 says, once the §6.0 prerequisites have landed (until then P2 ships reads only) | A scripted conversation passes in the demo's suite, including permission, ceiling, approval-binding, revocation and injection cases, and history shows the actor |
| P3 | Training-plan app (first consumer outside this repo; the first release cycle). Memory, opt-in, with the view-and-delete UI. Settle the licence and package home (Q8) | Acceptance run passes; erasure removes memory and derived summaries |
| P4 | Internal CRM | Acceptance run passes; approve-always writes hold under the injection fixtures |
| P5 | ticket0 onto the loop; participants and the handoff contract and mirror | A thread escalates, a person replies in the user's chat, the user sees what was sent |
| P6 | Dashboard writes (roll back, redeploy) behind approvals; delegated reads (#1824); platform-side inference and streaming relay for verticals (#1073) | A write from the dashboard assistant needs a recorded approval bound to the approving user (§6.0 point 3), and the control plane records the actor |

## Sources

**Cloudflare**
- [Chat agents (`AIChatAgent`, `useAgentChat`)](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Build a chat agent](https://developers.cloudflare.com/agents/examples/chat-agent/)
- [Think](https://developers.cloudflare.com/agents/harnesses/think/)
- [Agents SDK v0.5.0 changelog (`@cloudflare/ai-chat` 0.1.0)](https://developers.cloudflare.com/changelog/post/2026-02-17-agents-sdk-v0.5.0/)
- [Long-running agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/)
- [Durable Objects: WebSockets and the Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [AI Gateway: features](https://developers.cloudflare.com/ai-gateway/features/), [spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/), [unified billing and `byok_only`](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), [limits](https://developers.cloudflare.com/ai-gateway/reference/limits/), [changelog](https://developers.cloudflare.com/changelog/product/ai-gateway/)
- [AI Search](https://developers.cloudflare.com/ai-search/)

**Protocols**
- [AG-UI concepts](https://docs.ag-ui.com/concepts) and [architecture](https://docs.ag-ui.com/concepts/architecture)
- [AI SDK stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [MCP Apps (Thoughtworks Radar)](https://www.thoughtworks.com/radar/platforms/mcp-apps) and [the ext-apps SDK](https://docsearch.algolia.com/mcp/docs/repo/modelcontextprotocol/ext-apps)

**Context and memory**
- [Anthropic cookbook: compaction, tool-result clearing, memory](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
- [Lovable: workspace and project knowledge](https://docs.lovable.dev/features/knowledge)
- [Mem0: context engineering for agents](https://mem0.ai/blog/context-engineering-ai-agents-guide) (vendor)
- [Memory in the Age of AI Agents](https://arxiv.org/pdf/2512.13564)
- [Oracle: the four context-engineering operations](https://blogs.oracle.com/developers/what-is-context-engineering-the-four-operations-that-decide-whether-your-agent-survives-production)
- [Suppressed or deleted? What happens when you remove an AI memory](https://calmara.app/blog/suppressed-or-deleted-ai-memory) (vendor)

**Security**
- [The lethal trifecta for AI agents (Willison)](https://simonw.substack.com/p/the-lethal-trifecta-for-ai-agents)
- [Design patterns for securing LLM agents against prompt injections](https://arxiv.org/pdf/2506.08837)
- [Willison on the design-patterns paper and CaMeL](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/)

**Experience and accessibility**
- [Designing for agentic AI: control, consent, accountability (Smashing)](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)
- [Identifying necessary transparency moments in agentic AI (Smashing)](https://www.smashingmagazine.com/2026/04/identifying-necessary-transparency-moments-agentic-ai-part1/)
- [AI chat UI best practices](https://thefrontkit.com/blogs/ai-chat-ui-best-practices) and [chatbot UX patterns](https://ai-tldr.dev/learn/building-ai-apps/ai-ux-patterns/chatbot-ux-patterns/)
- [Announce completed AI responses, not streaming tokens](https://github.com/d-oit/do-knowledge-studio/pull/926) (issue-thread practice)
- [Chatbot accessibility playbook (MITRE)](https://mitre.github.io/chatbot-accessibility-playbook/docs/4_4_8.html)
