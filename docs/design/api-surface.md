# RFC: API surface — every vertical serves its own OpenAPI, Scalar renders it

**Status:** proposed · **Implements:** [master-plan.md](../master-plan.md) decision 22 /
[kernel-design.md](./kernel-design.md) K-9 (zod-openapi on Hono; OAS emitted + CI-diffed)
and the "API surface — build cheap early" buy/build row. **Depends on:**
[vertical-auth-detach.md](./vertical-auth-detach.md) (vertical-owned sessions are the auth
the docs page rides), [dashboard-ui.md](./dashboard-ui.md) (the AppDetail screen that links
out). **Touches, later:** master-plan decision 29 (event schemas → AsyncAPI, §6).

## 1. Problem

Decision 22 pinned the contract story three weeks ago — Zod schemas are the source of
truth, the HTTP surface emits OAS, the emitted document is checked in and CI-diffed — and
none of it exists. There is no `openapi.json` anywhere in the repo, no package depends on
a zod-openapi library, and the manifest field built for it
([manifest.ts](../../packages/contracts/src/manifest.ts) `api?: string`) is set by nothing
and read by nothing.

Meanwhile every vertical already *has* a complete, typed HTTP surface, in one of two
shapes. Callout (the legacy shape) hand-writes a REST route table
([demos/callout/src/routes.ts](../../demos/callout/src/routes.ts)) mapping paths onto
`stub.invoke('module/operation', input)`. The sandbox-clean verticals expose the
operations directly: Manyfold serves `POST /api/op/<name>` against an exported allowlist
([demos/manyfold/src/routes.ts](../../demos/manyfold/src/routes.ts) `OPERATIONS`),
Meridian a generic `POST /api/invoke` — "the kernel checks the permission inside every
operation, so a generic route is exactly as safe as an explicit table." Either way, every
operation parses its input with a Zod schema at the boundary. The schemas exist; they are
just invisible — module-private consts buried beside handler bodies, where no tool, no
external consumer, and no operator can see them.

Three audiences lose:

- **Tenant developers** integrating against a vertical's API have nothing to read and
  nothing to try. The master plan's API-surface row ("per-tenant keys, rate limits,
  webhooks") presumes a documented surface to put keys in front of.
- **Builders** who `substrat push` a vertical get a hostname in the dashboard and no
  statement of what it serves.
- **The platform itself**: the API-shape half of the D-22 review checkpoint — a human
  reading an emitted diff — has no artifact to diff. Permission drift is caught
  (`PERMISSIONS.md` + `lint:permissions --check`); API drift is not.

One boundary to respect: [generated-verticals.md](./generated-verticals.md) §4 says "no
OpenAPI to maintain, no route layer to drift" — and it is right, *for the frontend*. The
typed SDK stays the internal contract. OAS is for the other three audiences; nothing in
this RFC puts a generated client between a vertical's own web app and its API.

## 2. Decisions

### 2.1 The operation catalog is the authoring surface

The vertical exports an **operation catalog**: a map from operation name to
`{ summary, input, output }`, where `input`/`output` are the **same Zod schema objects
the handlers already parse** — the module promotes its private consts to exports and
references them, never redeclares them. One schema is both the runtime validator and the
documented contract; the document cannot drift from the enforcement because they are the
same object (the D-22 thesis, finally cashed in). Manyfold's exported `OPERATIONS`
allowlist is this catalog minus the schemas; the catalog replaces it (the allowlist
derives from the catalog's keys).

The OpenAPI 3.1 document is generated from the catalog with `zod-openapi`
(Zod 4-compatible, matching the repo's `zod ^4.4`; K-9's named tool) — one path item per
operation on the `/api/op/{name}` convention (§2.2), programmatically, no per-route
ceremony. A vertical with bespoke REST routes (Callout's table, portal walks) hangs the
same catalog schemas on those route definitions when it converts.

**Rejected: kernel-generated spec from `ModuleRegistration`.** Making operations declare
their schemas in the *registration* is the right long-term move (it is what makes a
module self-describing to SDK generation and MCP tools, per master-plan §5.6) — but it is
a contracts + kernel change with its own review, and this RFC refuses to wait for it. The
catalog is deliberately shaped as that future declaration: when `ModuleRegistration`
grows schema fields, the catalog's entries move into it and the emit pipeline re-points —
a moved reference, not a rewritten contract (§5).

### 2.2 Two well-known paths, same gate as the API — and one invoke convention

Every vertical serves, from its own origin:

- **`GET /openapi.json`** — the OpenAPI 3.1 document.
- **`GET /api/docs`** — the Scalar API Reference rendering it.

The documented invoke surface is **`POST /api/op/{name}`** — Manyfold's existing
convention, promoted to the platform default. One URL per operation is what makes the
document readable and the try-it client usable; a single `/api/invoke` endpoint with the
operation name in the body would collapse the whole surface into one path item with a
union body — valid OpenAPI, useless documentation. Meridian adds `/api/op/:name` as an
alias (a three-line route beside its existing `/api/invoke`, which stays for the SPA but
goes undocumented).

Both sit behind the **same session gate as the rest of `/api/*`** on hosted verticals: the
spec enumerates the attack surface and the docs page executes real requests, so neither is
anonymous. Local dev (`server.ts`, `x-principal` header) leaves them open, like every
other dev route. The paths are a **platform convention** — the dashboard constructs
`https://{hostname}/api/docs` from the hostname it already displays, no discovery
handshake. `manifest.api` is set to the repo-relative path of the checked-in emitted
document (§2.4), which is what "path to emitted OAS" always meant: a pointer for tooling,
not a URL.

### 2.3 Scalar, self-hosted, riding the session

Scalar's renderer is MIT with the try-it client included — no open-core gate on invoke
(the Redoc trap this choice avoids). Three configuration decisions, all mandatory:

- **No CDN.** The default integration loads the renderer bundle from jsdelivr. Verticals
  must not depend on a third-party origin to render their own docs: pin
  `@scalar/api-reference` as a dependency and serve the bundle as a static asset, the same
  way each vertical already serves its web bundle.
- **No proxy.** Scalar's optional CORS proxy (`proxy.scalar.com`) would route tenant API
  traffic — with session cookies — through Scalar's infrastructure. Same-origin docs need
  no proxy; never configure one.
- **`customFetch` with same-origin credentials.** Try-it requests carry the caller's own
  session cookie. Requests execute as the logged-in principal, `ctx.check` runs for real,
  and a 403 in the playground is the permission system demonstrating itself. No token
  pasting, no auth UI.

The document declares its security honestly: a `cookie` security scheme now; a
`bearer`/apiKey scheme is **reserved for per-tenant API keys** (master-plan API-surface
row) and added only when keys exist — Scalar renders the paste-a-key field from the
declaration alone, so key support later is a spec edit, not a docs-page change.

### 2.4 The emitted document is checked in and CI-diffed

`pnpm lint:api` renders each vertical's `openapi.json` from its operation catalog and writes it
next to `PERMISSIONS.md`; CI re-runs it with `--check` and fails on drift — the identical
mechanism, because it serves the identical purpose: **a surface change cannot merge
without appearing in the PR diff.** This is the D-22 human checkpoint for the API shape,
joining the migration diff and the permission diff. Breaking-change *linting* (oasdiff or
similar classifying removals/retypes as errors) is a follow-up once the artifact exists;
the reviewable diff comes first.

### 2.5 The dashboard links out; it does not embed

[AppDetail](../../apps/dashboard/web/src/views/AppDetail.tsx) gains an **API** row beside
the hostname row: the spec URL (copyable) and an "API docs ↗" link to
`https://{hostname}/api/docs`.

**Rejected: iframing the docs into the dashboard.** The iframe would need third-party
cookies to the vertical's origin — the exact mechanism browsers are removing — and
embedding Scalar's Vue runtime in the React dashboard fights `@substrat-run/ui` for no
gain. The user's vertical session lives on the vertical's origin; the docs belong there
too. If the dashboard later wants an inline *view* (not try-it), it renders the spec JSON
read-only with its own components, fetched through the worker like the existing
introspection reads.

## 3. Rollout

1. **Meridian** — the reference implementation, for the same reason it is the reference
   for everything else: it is the canonical sandbox-clean shape, and its operation surface
   (employees, leave, time, expenses, payroll, contracts, onboarding) is the richest demo
   of what the docs page is for. Export the catalog from `module.ts`, add the
   `/api/op/:name` alias, the two routes, emit + check in `openapi.json`, wire `lint:api`
   into CI. This PR is the pattern.
2. **Manyfold** — near-free follow-up: it already serves `/api/op/<name>`; the `OPERATIONS`
   allowlist becomes the catalog's keys.
3. **new-vertical skill** — the scaffold templates export a catalog from day one, so every
   future vertical is born documented.
4. **Dashboard** — the AppDetail API row. Ships independently of 1–3 (it is just a link
   convention on the hostname).
5. **The rest of the fleet** (shop, rally, callout, …) — adopt as touched. Callout is
   last, not first: it is the legacy shape awaiting its sandbox-clean migration, and its
   hand-written REST table means real per-route conversion work that buys the platform
   nothing the reference PR hasn't already proven.

## 4. What this deliberately does not do

- **No SDK generation, no MCP tools yet.** Both are "derived from the contracts package"
  in the master plan; both want §2.1's rejected-for-now operation-declared schemas. The
  emitted OAS is a prerequisite, not the deliverable.
- **No public specs.** Gating behind the session is the conservative default; a vertical
  that wants a public developer portal opts out deliberately, later, with rate limits in
  front (API-surface row).
- **No AsyncAPI authoring.** Deferred per decision 29 — but not forgotten, see §6.

## 5. Revisit trigger: self-describing operations

The moment a consumer needs machine-derived access to operations (generated verticals
emitting their own route tables, MCP tool generation, typed SDK emit), operations grow
declared input/output schemas in `ModuleRegistration` and the manifest's `api` story is
re-grounded on them. §2.1's catalog is deliberately that declaration living one layer too
low: its entries move into `ModuleRegistration` field-for-field, the emit pipeline
re-points, and nothing else changes — a moved reference, not a rewritten contract.

## 6. Future: the events section, for free

Decision 29 pins per-`(type, schemaVersion)` Zod event schemas with AsyncAPI *generated*
from them once external consumers exist (AsyncAPI 3 embeds JSON Schema). Scalar renders
AsyncAPI natively — including 3.1, channels, message payloads — and **mixes OpenAPI and
AsyncAPI documents in a single reference**. When the decision-29 emit pipeline lands, the
same `/api/docs` page grows an events section by adding one document to the Scalar config:
the fat-event contract, documented beside the HTTP surface it complements, with no new
tool. TypeSpec stays dropped (K-9); Scalar only ever sees emitted documents, which is all
it needs.

## 7. Open questions

1. **Breaking-change linter** — oasdiff in CI classifying the emitted diff, or trust the
   human checkpoint until an external consumer exists? (Leaning: human first; the
   permission diff sets the precedent.)
2. **Spec metadata** — where do title/version/description come from? The manifest already
   carries module id + schemaVersion; the vertical's package.json carries the deployed
   version. Probably manifest for identity, package version for `info.version`.
3. **Portal surfaces** — Callout's portal routes are permission-narrowed per entity; does
   the spec document them in the same document with the `cookie` scheme, or does a portal
   audience deserve a filtered document? (Leaning: one document; the permission system
   already answers who can call what.)

## 8. Resolved since (2026-07-27)

- **Same origin, confirmed.** A docs subdomain (prefix or `-docs` suffix) was considered
  and rejected for the authenticated surface: origins are per-host, `sb_session` is
  host-only, so any second hostname either breaks try-it (CORS + credentials — the
  machinery §2.3 rejected) or demands a second sign-in and demonstrates the API against
  the wrong base URL. The `-docs` **suffix** (one label — the wildcard cert covers it;
  the router already routes by surface) is banked as the shape of the future *public*
  docs surface, where no session exists and the argument vanishes; try-it there targets
  the canonical host with per-tenant API keys.
- **Route override: manifest field, deferred until wanted.** `/api/docs` +
  `/openapi.json` stay the default convention. When a vertical needs a different path,
  the override is an optional additive manifest field (`apiDocs: { specPath?, docsPath? }`
  — NOT the existing `api` field, which names the checked-in artifact), and it is only
  buildable as a trio: manifest field + the vertical's route wiring reading it + the
  registry/dashboard passing it through to the AppDetail link. A convention override the
  dashboard cannot discover breaks the link exactly when someone uses the feature, so the
  field ships with the discovery plumbing or not at all.
