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

## The widget on the real docs site

The fake sites are stand-ins. To put the widget on the actual documentation:

```sh
TICKET0_WIDGET=1 pnpm --filter @substrat-run/docs dev     # :5173
```

That is the whole dogfood — the widget on substrat.net's own site, answering out of
substrat.net's own `llms-full.txt`. It is **opt-in** because the same config array
ships to production, and a support widget on the live site is a deliberate decision
rather than a side effect of this demo landing.

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

Give it Cloudflare Workers AI and it generates instead — copy `.env.example` to `.env`:

```sh
CF_ACCOUNT_ID=…      # the token needs "Workers AI: Read"
CF_AI_TOKEN=…
# TICKET0_MODEL=@cf/meta/llama-3.1-8b-instruct   (the default)
```

Token counts come from the provider where it reports them and are estimated otherwise —
which is exactly why this demo prices usage for display and never for money.

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
  caller and refused unless they hold `kb:manage`.

The model credentials are per-install (`CF_ACCOUNT_ID`, `CF_AI_TOKEN` in the dashboard's
Env tab), never a deployment-wide binding — one serving script runs every desk, and a
shared binding would bill them all to whoever set it last. A desk with neither still
works: answers become extractive quotes, labelled `offline/extractive`.

`substrat.outbound` declares the two hosts this vertical may reach — `api.cloudflare.com`
(Workers AI) and `substrat.net` (this desk's own documentation). A desk pointed at
somebody else's docs needs that host added to the declaration and a new version pushed;
the egress allowlist is a fact about the version, not about the install.
