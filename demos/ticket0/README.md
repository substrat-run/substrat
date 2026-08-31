# ticket0

An AI-assisted support desk: a chat widget you embed on your site, an inbox that
receives email, and an assistant that answers from your own documentation and is honest
about what it cost.

Design: [`spec/concept.md`](spec/concept.md). Declared surface: [`spec/model.ts`](spec/model.ts).

```sh
pnpm --filter @substrat-run/demo-ticket0 test    # 58 tests, denials included
pnpm --filter @substrat-run/demo-ticket0 dev     # issuer :8879 · api :8874 · app :5281
```

`dev` brings up four things:

| | |
|---|---|
| [:5281](http://localhost:5281) | the desk — inbox, settings, portal (React) |
| [:5279](http://localhost:5279) | a stand-in customer site with the widget on it — **Substrat's desk**, real docs, real answers |
| :8874 | the API, and the public widget surface |
| :8879 | the dev OIDC issuer — sign in by picking a name |

Sign in as **Markus** (desk admin — sees cost) or **Anna** (agent — cannot). The
difference is visible on the same screen, and it is a permission rather than a flag.

Kestrel has no stand-in site of its own. It is the **supervised** desk — its assistant
drafts and never posts — so a marketing page to watch an assistant decline to answer
was scenery for a negative. That behaviour is asserted in the tests and visible in the
inbox as a draft awaiting a human (sign in as Dana or Omar).

## Embedding the widget

One `<script>` tag, and nothing else — no npm package, no custom element, no build step
on the customer's side:

```html
<script src="https://desk.example/widget.js"
        data-user="marcus@parcelbay.com"
        data-signature="a3f1…"></script>
```

`widget/widget.js` is a vanilla IIFE that appends its own `<div>` to `document.body` and
renders into a **shadow root**, so the host page's CSS cannot reach in and the widget's
cannot leak out. It ships no framework because it runs on somebody else's page, and it
follows that page's `prefers-color-scheme` — a widget that is light on a dark site reads
as an advert rather than part of the product.

| attribute | |
|---|---|
| `src` | the desk. Also the default API base — the script reads its own origin, so nothing is baked in at build time |
| `data-api` | override the base. Only the demo needs it, because the stand-in sites are served from their own ports |
| `data-user` | who this visitor is, as far as the embedding site is concerned |
| `data-signature` | that site's **server** vouching for the claim |

Both identity attributes or neither. Without them the visitor is anonymous, and gets a
contact nothing else will ever reach — made by their first message, never by opening the
bubble, so a visitor who clicks and leaves is no record at all; with them the header says
*"your site verified you"*, because the desk could check.

**The signature is the mechanism, not a formality.** It is
`HMAC-SHA256(desk secret, data-user)`, hex — what Intercom calls `user_hash` and Help
Scout calls a Beacon signature. The embedding site's backend computes it from a secret
this script never sees, which is exactly what stops a visitor claiming somebody else's
identity in devtools. The desk mints that secret at Settings → Identity verification
(`POST /api/desk/verification-secret`), which returns it **once** — every read of the
desk omits it, and rotating invalidates every signature the customer's site is currently
producing.

**Which sites may embed is the desk's decision.** `configure-desk` holds an origin
allowlist (Settings → Widget origins), and `harness/widget-surface.ts` checks the
request's `Origin` **header** against it — never a body field, which would be a
suggestion rather than a fact. The check runs in middleware — it answers the preflight
itself, and it refuses the request *before* the handler, because withholding
`access-control-allow-origin` stops a browser *reading* a response and does nothing to
stop the write behind it. An origin removed from
the list stops working without a redeploy; the list is read per request.

Behind the script are three unauthenticated routes — open a session, post a message, read
the thread — confined by a session token rather than a login, since a visitor in a chat
bubble has no principal. The session lives in `localStorage`; a token that no longer names
anything (reaped session, reseeded desk) is thrown away and replaced silently rather than
shown to the visitor as an id.

Replies arrive by **polling** — 1.5s while an answer is outstanding, 10s idle, and not at
all in a hidden tab. That is a stopgap and `widget.js` says so: the right answer is a
WebSocket on the scope's own Durable Object, and neither the router nor the DO carries an
`Upgrade` today, so it is platform work rather than a change to that file.

The script is served by the dev server from `src/server.ts` with
`access-control-allow-origin: *` — the script is public, the API behind it is not. A
deployed desk serves it from the edge instead: `scripts/copy-widget.mjs` copies it beside
the built SPA, deliberately outside Vite's import graph, because it is not part of this
app — it is part of somebody else's.

## The widget on the real docs site

The fake sites are stand-ins. To put the widget on the actual documentation:

```sh
TICKET0_WIDGET=1 pnpm --filter @substrat-run/docs dev     # :5173
```

That is the whole dogfood — the widget on substrat.net's own site, answering out of
substrat.net's own `llms-full.txt`. It is **opt-in** because the same config array
ships to production, and a support widget on the live site is a deliberate decision
rather than a side effect of this demo landing.

The site also carries the widget on **one page**, always:
[substrat.net/guide/support](https://substrat.net/guide/support) mounts `<Ticket0Widget
desk="https://ticket0.substrat.net" />` (`apps/docs/.vitepress/theme/components/`),
which appends the same `<script>` tag on the way in and calls `window.ticket0.unmount()`
on the way out. That verb exists for exactly this: a host with a client-side router
adds and removes tags without a reload, and a removed `<script>` undoes nothing — so
`widget.js` keeps one widget per page (a second run replaces the first) and offers the
host one way to take it down, poll and all. For the hosted desk to answer there,
`https://substrat.net` must be on its origin allowlist (Settings → Widget origins), and
`http://localhost:5173` for the docs dev server.

## When the assistant does not answer

Nothing the assistant does is allowed to fail silently — a customer message with no
turn against it looks exactly like a slow assistant, and it used to be the only trace
a broken one left. Three things now happen, in this order:

1. **The reason is on the turn.** A `failed` turn carries `error` — the provider's
   status line, the refused permission, whatever threw — and the conversation draws it
   as a *could not answer* card. A model that threw and an index that refused are
   recorded the same way, by the assistant, through `record-answer`, with nothing
   billed.
2. **When the assistant itself cannot act** — its service principal was never minted,
   its role never assigned, its first call refused — the host's `catch` records the
   failure through the **widget**, the principal that just accepted the message
   (`ticket0/record-assistant-failure`). Same row, same card, and an internal system
   note the customer never sees. Both hosts do this; the worker also logs it, so the
   platform's observability tail has the reason too.
3. **Settings → Assistant** shows which model this install would answer with — and
   says plainly when it is `offline/extractive`, i.e. quoting the docs because the
   platform holds no credential for the chosen provider — and where inference runs —
   beside the last day's turn and failure counts
   and the newest failures, each linked to its conversation. That read is
   `GET /api/assistant/status` (`harness/assistant-status.ts`), which wraps the declared
   `ticket0/assistant-health` and adds the one fact module code cannot know.

So "I can't get answers" has an answer of its own: open the conversation and read the
card, or open Settings → Assistant and read the list.

## The knowledge base is the real Substrat docs

On first boot the desk ingests `https://substrat.net/llms-full.txt` and turns it into
**538 citable sections**, each anchored at the heading that answers — so a citation
lands on the paragraph rather than a page to hunt through. Re-ingesting unchanged
content writes nothing; the content hash sees to that. `TICKET0_SKIP_INGEST=1` skips it.

Kestrel's documentation URL is deliberately fake, so one source succeeds and one fails
on every fresh boot. A desk whose knowledge base can only be seen working is a desk
whose failure state nobody has looked at.

## The model

By default there is **no model**: the assistant retrieves the best-matching section and
quotes it, labelled `offline/extractive` so a turn record can never be mistaken for a
generated answer. The demo runs with no credentials at all.

Give the platform a credential for the chosen provider and it generates instead — copy
`.env.example` to `.env` (the dev server is the platform here):

```sh
# TICKET0_MODEL=cloudflare:@cf/meta/llama-3.1-8b-instruct-fast   (the default)
CLOUDFLARE_AI_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
CLOUDFLARE_AI_API_TOKEN=…                                  # Workers AI run
```

Any row of the platform's provider table works the same way — `scaleway:…` with
`SCALEWAY_API_KEY`, `anthropic:…` with `ANTHROPIC_API_KEY`. The model call goes through
the platform's model host (`@substrat-run/vertical-host/model`, #1054), which prices the
provider's reported token counts from the rate card and hands the desk one usage line;
the desk records it in its own meter and raises it to the platform's ledger in the same
transaction. Counts the provider did not report stay zero and say so — never estimated
into a bill.

## The screens

Built from `spec/design-prompt.md`'s canvas handoff. The three constraints it calls
product rather than styling are each marked in the code where they live:

1. **public vs internal** — `app/src/views/Conversation.tsx`, `Composer`: internal mode
   restyles the entire surface (amber field, 1.5px border, inset stripe, amber caret,
   persistent label naming the customer). ⇥ toggles, ⌘↵ sends.
2. **agents never see cost** — the usage card is *absent*, not disabled, and absent
   because the API refused. Signed in as Anna there is no `$` figure on the page at all.
3. **the assistant is staff** — same avatar and meta treatment as a human. Only its
   DRAFT gets the special card: dashed border, `DRAFT · NOT SENT`, confidence bar,
   checkable citations, Send / Edit / Discard.

**Reports** (`app/src/views/Reports.tsx`) is the second screen behind `usage:read`, and
it is behind that key rather than a gentler one on purpose: its headline is cost per
resolved conversation, which is the money with a denominator. `ticket0/desk-metrics`
answers the whole screen in one read over rows the desk already had — volume by channel,
median and p90 first-response and resolution time, the backlog and its oldest untouched
thread, who resolved and replied, CSAT, and the assistant's deflection, escalation and
failure rates. Constraint 2 above applies here too: signed in as Anna the nav item is
absent, because the API refused.

The inbox filters narrow the read **on the server**: `state`, `assignee`, `channel` and
`priority` are declared inputs on `ticket0/list-conversations`, and the kernel composes
the `WHERE` and provisions the indexes from the same operation's `filterable`. A chip
that says "State: Open" over an unfiltered list is a promise the screen is not keeping,
so they are wired rather than drawn. "Assigned to me" is the same mechanism.

## Deploying it

ticket0 is a pushable vertical: `src/worker.ts` is the deploy entry (sandbox-clean,
control-plane-less — one `ScopeDO` per desk plus the shared per-tenant `IdentityDO`),
and `substrat.runtimeNeeds` in package.json is the whole deploy config. There is no
wrangler.jsonc; the CLI derives one.

```sh
substrat push                       # bundles the worker, builds app/ + widget.js as assets
substrat promote ticket0 --channel prod --version <id> --ack-permissions --ack-migrations
substrat hostnames bind ticket0 --surface app
```

Three things differ from `pnpm dev`, and all three live in `worker.ts`:

| | dev server | hosted |
|---|---|---|
| which desk | the embedding origin, across two seeded desks on one node | the hostname the router resolved — one desk per install |
| the login | `packages/dev-issuer` | whatever OIDC issuer the tenant bound (`substrat:auth`); the desk runs no credential store |
| the assistant's turn | floated; node keeps the process alive | `executionCtx.waitUntil`, or the isolate cancels it mid-answer |

Everything else is shared code: the `/api` table comes from `spec/model.ts` through
`src/routes.ts`, and the public `/widget/*` surface is the same
`harness/widget-surface.ts` both hosts mount.

What a hosted desk does **not** get from a seed, and how it gets it instead:

- **Three service accounts.** `/internal/provision` mints the desk's `widget`,
  `assistant` and `relay` principals once and records them in the tenant's identity DO.
  The assistant is minted SUPERVISED (`assistant` — drafts, never sends); handing it
  `assistant-autonomous` is a decision an admin makes on purpose.
- **Teammates and portal customers.** `POST /api/invites` — `desk-admin` / `agent` at
  scope level, or `customer` with a `contactId`, which grants `conversation:read-own`
  on that one contact and nothing else.
- **A knowledge base.** A worker has no boot and a dispatch user-worker has no cron, so
  the ingest is a button: `POST /api/kb/sources/:sourceId/refresh`, running as the
  caller and refused unless they hold `kb:manage`. Settings → Knowledge base adds a
  source and reads it at once; a read that fails is recorded on the source
  (`ticket0/record-kb-ingest-failure`), so the row shows the reason rather than
  spinning at `ingesting`.

The model credential is the **platform's** (`CLOUDFLARE_AI_*`, `ANTHROPIC_API_KEY`, … as
deployment-wide bindings, #1054), and the desk's setting is only *which* model
(`TICKET0_MODEL` in the dashboard's Env tab). That inverts the earlier per-install token:
the platform pays the provider and meters each desk by the five attribution keys on every
line, so one serving script can run every desk without billing them to whoever set a
token last. A desk whose provider the platform holds nothing for still works: answers
become extractive quotes, labelled `offline/extractive`.

`substrat.outbound` declares the two hosts this vertical may reach — `api.cloudflare.com`
(Workers AI) and `substrat.net` (this desk's own documentation). A desk pointed at
somebody else's docs needs that host added to the declaration and a new version pushed;
the egress allowlist is a fact about the version, not about the install.
