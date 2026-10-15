---
status: proposed
layer: plan
description: One chat in every product — a thread with an AI, and sometimes a person, that answers and acts as the signed-in user. Argues the stream protocol, the record, the host loop, the UI element, context, memory and the support handoff, and the bar for the experience.
---

# RFC: the assistant — one thread, any product, acting as the user

**Status: proposed. Nothing here is agreed.** It recommends; a human decides. The decisions it
asks for are collected in §16, where the ones taken as working decisions for P1 are marked. Written against `origin/main` at `c95e6d73a` and against the
outside world as of 2026-10-14. Claims about the repo carry a file or an issue; claims about
the outside world carry a source in §17; anything I could not check says so in §15.

Related: [#1824](https://github.com/substrat-run/substrat/issues/1824) (delegated MCP access),
[#1073](https://github.com/substrat-run/substrat/issues/1073) (platform-side inference),
[#1749](https://github.com/substrat-run/substrat/issues/1749) (AI text with provenance in the
dashboard), [#1705](https://github.com/substrat-run/substrat/issues/1705) (cross-vertical
events), [#1671](https://github.com/substrat-run/substrat/issues/1671) (what K-15 says about
runtime UI), [#112](https://github.com/substrat-run/substrat/issues/112) (the MCP surface),
[#1454](https://github.com/substrat-run/substrat/issues/1454) (closed: "two apps is not enough
evidence to extract"). Companions: [scope-stores.md](scope-stores.md),
[agent-surface.md](agent-surface.md).

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
| ticket0, the support desk | Answer from the knowledge base, hand off to a person |
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

1. **The assistant acts as the signed-in user, with a ceiling.** It can never do something the
   user could not. Every tool call goes through the same `assertAllowed` the user's own click
   would. No standing authority of its own.
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
8. **Extract from evidence, build for the next consumer.** Four consumers exist; §12 orders
   them so each one tests whether the shared part is really shared.

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
   ├── tools ──────────────────► the vertical's own operations, as the signed-in user
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
- **A call is `stub.invoke(operation, input)` on a stub resolved per request.** The principal
  is the stub's, so authority is the user's by construction, and a refusal is returned
  **in-band** (`isError`) for the model to read. A 401 is the one error that is not swallowed.
- **So the assistant's curation is the explicit `assistant.expose` opt-in (§6.1), not a
  permission filter.** Fifty-nine tools in a prompt is also a cost and an accuracy problem, not
  only a safety one. The derivation and call path are reusable as they are; the default is
  inverted (MCP is on unless `mcp: false`; the assistant is off unless exposed).

## 5. The parts

### 5.1 The stream protocol (`contracts`)

A Zod schema `assistantStreamEvent`, owned here, **shaped like** the AI SDK's `UIMessage`
parts so a mapping to and from it is mechanical: text, reasoning (collapsed by default),
tool-input, tool-output, tool-approval-request, source/citation, file, and `data-substrat-*`
for what is ours: **approval**, **provenance** (the "AI" marker, when, from how many sources,
the query it ran: what #1749 asks for), **participant-joined**, **handoff-state**,
**budget-notice**, **memory-proposed**.

Why own it: the published element and the clients must not break when `ai` ships a major.
Why align the shape: Cloudflare's chat stack, `useChat`-style hooks and AG-UI adapters then
come nearly free. An AG-UI adapter is a later, optional edge.

Resumability is part of the contract, not an add-on: every event carries a monotonically
increasing id, and a client reconnects with the last id it saw.

### 5.2 `engine-assistant`, composed by call

The engine owns the invariants and nothing else:

- **Messages are append-only.** A message has a parent (a tree), so regenerate and edit-and-
  resend create branches. Nothing is overwritten.
- **A gated tool call cannot run without an approval**, and the approval is bound to a digest
  of the proposed input. The model cannot alter the arguments after the user said yes.
  The approver must be the thread's user principal, not the AI participant.
- **A tool call's states only move forward** (proposed, approved or denied, running, done or
  failed).
- **Every mutation emits a fat event.** Nothing needs a cross-module read.
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
   engine. Simple, no new object, weaker on a long run and on reconnect mid-turn.
2. **A Durable Object per thread** holding the WebSocket (hibernating) and the in-flight run,
   with the engine still the record. This is a platform-run object per scope, which is exactly
   what [scope-stores.md](scope-stores.md) proposes as a *kind*. I have not checked whether the
   assistant fits that mechanism; it looks like a natural first non-trivial kind.
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

The protocol in §5.1 is identical either way, so the choice does not leak to clients. How a
vertical is given the object (a scope-store kind, or a class the uploader supplies as it does
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
  outbound, and an inbound message path. New work, designed in P4.
- **Delegated reads the other way** ([#1824](https://github.com/substrat-run/substrat/issues/1824)):
  the desk's own assistant may read a user's diagnostic state (a team's last deploy, recent
  failures) through token exchange with an actor ceiling. **Read-only, never writes on the
  control plane.** Writes happen in the product's own assistant, with the user watching.

## 6. Authority and safety

### 6.1 The rule

Tools are the vertical's operations. The host invokes each as the signed-in user's principal.
The assistant therefore needs no permission model of its own: the user's role is the ceiling.
A call the user may not make is refused by the operation itself and comes back in-band for the
model to read, as it does over MCP today.

What the model is **offered** is the set of operations declared `assistant.expose`, which is a
curation decision made per operation in the model and reviewed in the PR. Narrowing that set
further by what *this* user may call would be a least-privilege floor and would shrink the
prompt, but it needs a read of a principal's grants that `ScopeStub` does not have today
(§4.1). It is worth adding for a narrow role (a customer or a trainee) and buys little for an
admin; it is an open item, not something this design assumes.

An operation opts in, in the model:

```ts
// illustrative sketch of an operation declaration, not a decided API
assistant: {
  expose: true,
  effect: 'read' | 'write' | 'irreversible',   // default derived; 'irreversible' explicit
  label: 'Log a set',                            // human wording shown in the UI
  preview: (input) => ({ ... }),                 // what the approval card shows
  undo: 'ops/unlog-set',                         // optional; makes a write reversible
}
```

Reads run without a prompt. Writes show a **preview card** (what will change, in the user's
words) and need approval; a write with a declared `undo` may instead run and show an undo
control, which the research suggests is the right trade for low-stakes, reversible changes.
Irreversible operations always need a preview and an approval. The default for an exposed
write with no declaration is **approve first**; loosening is explicit and reviewed.

### 6.2 The permission-diff checkpoint covers the assistant

`PERMISSIONS.md` already renders what each role can do. It gains an **assistant reach**
section: for each role, the exposed operations and their effect class. Widening what the
assistant can do then appears in the PR diff and cannot merge unseen, which is the
repository's existing answer to "agents never self-approve". This is a new human checkpoint
by extension, not a new mechanism.

### 6.3 Prompt injection, per consumer

| Consumer | Untrusted text the model will read | Consequential tools | Posture |
|---|---|---|---|
| Training-plan app | Mostly the user's own input | Edit a plan, log sets | Low risk; approve writes anyway |
| Internal CRM | Customer-authored notes, imported fields, inbound email | Edit or delete records, send mail | **Highest risk.** Writes approve-always; no tool that sends externally without approval; never let one turn both read an untrusted field and write on its basis without a human step |
| ticket0 | Anything a visitor types or a KB article contains | Handoff, reply | Replies are drafts or constrained answers; no data tools beyond the asker's own |
| Dashboard | Log lines, error messages from tenants' code | Roll back, redeploy (later) | Read-only in the first release (§12.1): no outward links or images, no tools that write |

Design rules, all structural:

- **Approve-always for writes where untrusted text is in context.** The approval card shows
  *our* description of the action (from `preview`), not the model's prose, so injected text
  cannot rewrite what the user is approving.
- **Quarantine large untrusted fields.** When a note or message must be summarised, a call
  with no tools does it, and its output is passed on as data. (The CaMeL idea, applied
  narrowly.)
- **No outward channel the model controls.** Markdown images and links are the classic
  exfiltration route. The renderer drops remote images and shows link targets, or routes them
  through an allowlist. Tools never take a free-form URL to fetch.
- **Cross-tenant is impossible by construction**, because every call is an operation in the
  user's own scope as the user.
- **Defence in depth:** AI Gateway guardrails and DLP on the way in and out. Useful, never the
  control.

### 6.4 What testing must prove

Mechanical, not hoped for (§11): a user without a permission never sees the tool and a forced
call is refused; an injected instruction in a fixture note produces no write without approval;
an approved call with altered arguments is refused; a budget-exhausted user gets the defined
message, not a stack trace.

## 7. Context

Each turn the host **assembles** the model's input; it is not "the whole thread". Layers, in
this order, because order decides whether the prompt cache hits:

1. **Standing instructions** (persona, rules, locale, the effect-class policy). Pinned. Never
   summarised, never dropped, re-injected every turn so compaction cannot erase them.
2. **Tool definitions** for this user (stable within a session, so cacheable).
3. **Memory** (§8): the small set of active items, not a search result.
4. **Where the user is.** The vertical supplies a function from the current route and entity
   to a few lines: "viewing order 123, status open". This is what makes the assistant feel
   like part of the app, and it is cheap. Shown to the user as a context chip they can remove.
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
   covers them like any other module table. Events about messages carry a `piiClass` and a
   `subjectId` so a payload can be shredded while the fact of the event remains.
9. **Memory is exportable** with the rest of a user's data.

### 8.3 What not to build yet

No vector memory, no automatic profile inference, no cross-session semantic recall in v1.
A short list of explicit items the user can read covers most of the value and is the only
version whose deletion semantics are easy to state truthfully.

## 9. Cost and limits

- **Before the call:** the model host's `guard` checks a per-user budget. The platform
  mirrors it with an AI Gateway spend limit scoped by user (custom metadata), so a bug in the
  vertical's own check cannot overspend. Note spend limits are eventually consistent.
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
| 1 | **Dashboard, read-only** | Ours: no cross-repo release, no customer data, no special-category data. Platform code, so it may hold the model binding itself and does not wait for #1073's relay. The material to explain already exists as code | The loop, the protocol, resume, the element, provenance (#1749), cost control, the §10 acceptance run, and the deployed P0b measurements |
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

- **No release cycle across repositories,** and no customer's data or health data in play.
- **#1073's concern does not apply.** That issue is about a *pushed vertical* holding the model
  capability. The dashboard is platform code, so it holds the model binding itself, with the
  platform's own metering and a per-user budget. #1073 stays the path for verticals (P6).
- **Two open questions get cheap answers.** The element ships inside the dashboard's own web
  app, so its licence and package home (Q8) can wait. The dashboard declares its own Durable
  Object classes, so "how is a vertical given the thread object" (Q2, the second half) can wait.
- **The deployed measurements (P0b) ride on it.** A preview deploy of the thread object, with
  a real model, is how the 30 s `waitUntil` cap, eviction, first-token time and idle cost get
  measured, instead of a separate exercise.

What it does **not** prove, which is why `demos/todo` follows immediately and is not optional:
the dashboard's tools are **hand-written wrappers over the read helpers above**, not derived
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

ticket0 becomes a **consumer** of the shared loop, with a persona, a KB-search tool and a
handoff tool, and keeps its own conversation model (customer and agent, statuses,
assignees, SLAs, snooze). It is not replaced. Its AI-authored messages link to an assistant
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
  bindings, and the absence of model and MCP code), not run. Where a thread's record lives for
  a team-scoped product is not decided.
- **Scope-store fit.** I read the opening of [scope-stores.md](scope-stores.md) only.
- **Dashboard tooling.** I did not check whether the dashboard exposes an MCP surface or only
  its internal control-plane API.
- **Library versions and sizes.** I did not pin an `ai` major, measure Lit's or Stencil's
  bundle size, or run either.
- **The MCP Apps spec identifier** differs between the sources I found (SEP number and MIME
  type), so check the official spec before implementing anything against it.
- **Legal.** I found no EDPB guidance specific to assistant memory; the retention and
  special-category points are general GDPR principles. They need review by someone qualified
  before the training-plan consumer ships.
- **Several sources are vendor blogs or preprints** (Mem0, accessibility issue threads, 2026
  arXiv papers). They inform the design; none of it rests on one of them alone.
- **Every number marked "target"** (latency, setup time) is an aspiration to measure in P0.

## 16. Decisions asked of a human

1. **Wire format.** Own a Zod schema shaped like the AI SDK's `UIMessage` parts and adapt at the
   edge (recommended), or adopt the AI SDK's types directly, or adopt AG-UI. **Working decision
   for P1: own the schema.**
2. **Where a live thread runs.** P0 (local) recommends a Durable Object per thread as the live
   coordinator over a placement-agnostic loop and record, with request plus `waitUntil` as the
   fallback shape (§5.3). **Working decision for P1: take that recommendation.** Deployed
   confirmation (P0b) happens on the dashboard's preview deploy. How the object is provided to
   a *vertical* (a scope-store kind, or a class the uploader supplies) is deferred; the
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

## 17. Risks

| Risk | Mitigation |
|---|---|
| Injection through customer-authored text in the CRM | §6.3: approve-always writes, our preview text, quarantine, no outward channel |
| Cost runaway from a looping agent | Step bound, per-turn caps, per-user budget before the call and at the gateway |
| The abstraction is shaped by one consumer | §12 order; ticket0 third specifically to break an operation-only design |
| Wire format churn | Own the schema; adapt at the edge |
| A clunky first release teaches users not to try | §10 is a release gate, with an acceptance run per consumer |
| Memory feels creepy or is mishandled (special-category data) | Opt-in, visible list, real deletion, legal review before shipping the coach |
| Inference stays in the vertical's worker longer than intended | Design does not depend on it; #1073 stays on the path |
| The element becomes a framework by accretion | The two-consumer rule for any new platform component |

## 18. Phases

| Phase | Work | Exit |
|---|---|---|
| P0 | **Done locally** (`spikes/assistant-thread`): the loop, stream and resume on both placements, with a scripted model on local workerd | Q2 answered for correctness |
| P1 | **Dashboard, read-only.** `contracts` event schema; `engine-assistant`; the thread object in the dashboard worker; the loop with a fake model first, then a real model through the platform's model host with a per-user budget; hand-written read tools over the existing helpers; the headless client and a first `<substrat-assistant>` inside the dashboard web app; provenance. A preview deploy for **P0b**: the 30 s cap, eviction, first-token time, the real append, idle cost | ⌘K Ask answers "why is this failing" with provenance, behind a flag; the §10 acceptance run passes; the P0b numbers are written into the spike's findings |
| P2 | **`demos/todo`.** `assistant.expose` and `mountAssistant` for declared operations; the generated tool manifest with `--check`; the assistant-reach section of `PERMISSIONS.md`; `assistantScenario()` with a fake model; the first evals; a digest-bound gated write | A scripted conversation passes in the demo's suite, including permission, approval-digest and injection cases |
| P3 | Training-plan app (first consumer outside this repo; the first release cycle). Memory, opt-in, with the view-and-delete UI. Settle the licence and package home (Q8) | Acceptance run passes; erasure removes memory and derived summaries |
| P4 | Internal CRM | Acceptance run passes; approve-always writes hold under the injection fixtures |
| P5 | ticket0 onto the loop; participants and the handoff contract and mirror | A thread escalates, a person replies in the user's chat, the user sees what was sent |
| P6 | Dashboard writes (roll back, redeploy) behind approvals; delegated reads (#1824); platform-side inference and streaming relay for verticals (#1073) | A write from the dashboard assistant needs a recorded, digest-bound approval |

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
