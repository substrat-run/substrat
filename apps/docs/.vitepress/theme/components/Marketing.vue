<script setup lang="ts">
// The marketing landing page.
//
// The page argues one claim — Substrat builds almost any business app, and the
// foundation arrives with it — and every section is evidence for it, in order:
// what people built (eight demos), what arrives free (the inventory), how little
// you write (one operation), how it is layered, the engines you may skip, and
// only then the guarantees. The older cut led with the five things Substrat
// fixes, which sold a patch for a gap rather than a way to build the app.
//
// Content lives in these consts rather than a sibling `.content.mts`: index.md is
// deliberately absent from llms.txt (see ALT_NOT_NEEDED in tools/llms-index.mts),
// because it restates prose the guide pages already carry. Every factual claim
// below was checked against the repo — the demo table in verticals/index.md, the
// engine list in engines/index.md, and the packages themselves.

// The eight demo verticals, in the order they make the argument. `kernel` marks
// the ones that compose no engine at all: three of eight, which is the strongest
// evidence that an engine is an option rather than a tax.
const demos = [
  {
    name: 'Callout', domain: 'field service', layer: 'engine', href: '/verticals/callout',
    body: 'Two engines cooperating through events with zero imports between them — and the pricing moment where vertical logic meets an engine transition.',
    uses: 'workorder · invoicing · protocol',
  },
  {
    name: 'Meridian', domain: 'HR', layer: 'kernel', href: '/verticals/meridian',
    body: 'The shape-breaker: its core domain has no engine, so leave, time and expenses are vertical code on the kernel alone. Multi-country scopes from one codebase.',
    uses: 'kernel — protocol for onboarding only',
  },
  {
    name: 'RallyPoint', domain: 'padel club', layer: 'engine', href: '/verticals/rallypoint',
    body: 'Allocation over an interval rather than a state machine, the lost race rejected with no locking code anywhere, and a player who holds no role at all reaching their own booking.',
    uses: 'booking · invoicing · invites',
  },
  {
    name: 'Manyfold', domain: 'headless CMS', layer: 'kernel', href: '/verticals/manyfold',
    body: 'Draft → review → publish that cannot skip, append-only revisions, freeze-on-publish with a content hash. One tenant runs many sites, each its own scope.',
    uses: 'kernel only — no engine',
  },
  {
    name: 'Kallkälla', domain: 'coffee shop', layer: 'engine', href: '/verticals/shop',
    body: 'Two audiences, one source of truth — a customer storefront and a staff back-office as separate apps over one API. Invoicing reused far outside field service.',
    uses: 'invoicing · own commerce module',
  },
  {
    name: 'ticket0', domain: 'support desk', layer: 'engine', href: '/verticals/ticket0',
    body: 'A public, unauthenticated surface — an embeddable widget held by a session token and an origin allowlist rather than a login. An AI assistant with a principal and a role.',
    uses: 'metering',
  },
  {
    name: 'Handlebar', domain: 'bike workshop', layer: 'engine', href: '/verticals/handlebar',
    body: 'Engine reuse — the same engines under new vocabulary, and the second shape that forced the protocol engine to be extracted from Callout in the first place.',
    uses: 'workorder · invoicing · protocol',
  },
  {
    name: 'Todo', domain: 'shared lists', layer: 'kernel', href: '/verticals/todo',
    body: 'Sharing one list with one person is a grant on that entity — revocable, transactional, never an org per row. A 403 wall told apart from an empty list.',
    uses: 'kernel only — no engine',
  },
];

// What arrives with the project. Nothing unshipped belongs here: the section's
// promise is that these exist the moment your project does, so a thing still in
// flight (an MCP surface, webhooks derived from the API) stays off until it lands.
const inventory: [string, [string, string][]][] = [
  ['The API', [
    ['A typed HTTP API', 'emitted from your declared model — no hand-written routes'],
    ['OpenAPI + live docs', 'served by the vertical, gated against drift in CI'],
    ['A generated browser client', 'paths, bodies, paged link walks'],
    ['Inputs parsed at the boundary', 'by the host, on every path in'],
    ['Full-text search', 'declare searchables, get a per-scope index'],
  ]],
  ['Identity & the record', [
    ['OIDC login', 'any issuer, sessions, per-tenant identity directory'],
    ['Roles and permission keys', 'plus per-entity grants that revoke'],
    ['A permission diff in the repo', 're-emitted and gated, so a widened role shows up in review'],
    ['Stamped events on every mutation', 'tenant, scope, actor, time — unforgeable from above'],
    ['Timeline & history reads', 'with the authorization chain and PII class'],
    ['GDPR erasure with a receipt', 'because every event is classified'],
  ]],
  ['Data & environments', [
    ['A database per scope', 'not a tenant column you must remember'],
    ['Ordered, append-only migrations', 'emitted from the model, reviewed as a diff'],
    ['Snapshot any app’s data', 'an independent copy, on a TTL, reaped for you'],
    ['Every PR forks production', 'its migrations run on the copy, the URL gets posted'],
    ['Schema changes snapshot first', 'a bad migration has a rollback point'],
    ['Real data on your laptop', 'audited and masked by default'],
  ]],
  ['Ship & run', [
    ['One command to deploy', 'substrat push — build, upload, route'],
    ['Hosting, domains and TLS', 'a customer’s own hostname, issued for them'],
    ['A customer dashboard', 'teams, apps, deploys, data'],
    ['Metering and entitlements', 'usage as evidence, features as flags'],
    ['Connectors to the outside', 'with a declared egress allowlist per version'],
    ['SQLite locally, hosted in production', 'one codebase, no branch between them'],
  ]],
];

// The seven engines on a ring around the kernel. x/y are the node-box top-left
// inside the 1016×476 figure; the spokes are drawn to the kernel's centre and the
// opaque boxes cover their inner ends. `event` marks the one by-event engine,
// which deliberately exports no in-scope functions (see engines/index.md).
const ring = [
  { name: 'Work orders', x: 433, y: 47, cx: 508, cy: 73 },
  { name: 'Bookings', x: 699, y: 117, cx: 774, cy: 143 },
  { name: 'Invoicing', x: 765, y: 273, cx: 840, cy: 299, event: true },
  { name: 'Protocols', x: 581, y: 399, cx: 656, cy: 425 },
  { name: 'Invites', x: 286, y: 399, cx: 361, cy: 425 },
  { name: 'Absence', x: 102, y: 273, cx: 177, cy: 299 },
  { name: 'Metering', x: 167, y: 117, cx: 242, cy: 143 },
];

const cannots: [string, string, string][] = [
  [
    'Reach another tenant’s data',
    'Data access only exists as capability-scoped operations minted for one (tenant, scope) pair — a mismatch fails closed.',
    'fails closed',
  ],
  [
    'Skip the audit log',
    'Events are stamped with tenant, scope, actor, and timestamp below the API surface. Calling code cannot forge or suppress them.',
    'stamped below the API',
  ],
  [
    'Emit unclassified PII',
    'Every event carries a mandatory piiClass; a PII-classed event without a data-subject key fails validation, so GDPR erasure is always possible.',
    'piiClass required',
  ],
  [
    'Bypass the permission model',
    'Operations run inside the scope’s execution domain; every allow carries the proof path that granted it. The secure default is deny everything.',
    'deny by default',
  ],
];

// A real operation, lightly trimmed, from demos/callout/src/module.ts — the
// vertical wrapping the work-order engine in its own domain rule. Kept verbatim
// on purpose: an excerpt with the messy parts cropped is not evidence.
const sample = `// The vertical's own operation, composing the work-order engine.
const createWorkOrderOp = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.create));

  const facility = ctx.sql.query(
    'SELECT * FROM callout_facilities WHERE id = ?',
    [input.facilityId],
  )[0];
  if (!facility) throw new Error(\`facility not found\`);

  return createWorkOrder(ctx, {         // the engine's in-scope
    facility: ref('facility', facility.id),  // function, inside
    customer: ref('customer', facility.customer_id),
    kind: input.kind,                        // YOUR transaction
    title: input.title,
  });
};`;

const didnt: [string, string][] = [
  [
    'No tenant filter',
    'There is no WHERE tenant_id to forget. ctx.sql reaches this scope’s own database and cannot address another.',
  ],
  [
    'No audit call',
    'The engine emitted a work-order event stamped with tenant, scope, actor and time — below this code, which cannot forge or suppress it.',
  ],
  [
    'No transaction management',
    'The operation is the transaction. The throw on line 8 rolls back the rows, the events, and any platform intent it had enqueued.',
  ],
  [
    'No lock, no retry loop',
    'One operation runs in this scope at a time, to completion. Read-modify-write needs no ceremony.',
  ],
  [
    'No fork of the engine',
    'createWorkOrder is a plain export called inside the vertical’s own handler — extension by composition, so upgrading the engine stays an upgrade.',
  ],
];

// The three layers, as the landing page states them. Deliberately NOT the
// `LayerStack` figure from the architecture docs: that one draws five bands
// (adapters and connectors as well) and names five engines, both of which
// contradict what this section and the engine section below actually claim.
const stack = [
  {
    key: 'vertical', name: 'Verticals', owner: 'yours',
    role: 'Vocabulary, workflows, screens, pricing.',
    chips: [
      ['Callout', 'field service'], ['Meridian', 'HR'], ['RallyPoint', 'padel club'],
      ['Manyfold', 'CMS'], ['ticket0', 'support desk'],
    ],
  },
  {
    key: 'engine', name: 'Engines', owner: 'ours — headless, versioned',
    role: 'Shared domain machinery that owns invariants. Optional — compose them, or don’t.',
    chips: [
      ['workorder', 'state machine'], ['booking', 'allocation'],
      ['invoicing', 'immutable export'], ['protocol', 'sign → frozen'],
      ['invites', 'hashed identifier'], ['absence', 'entry ledger'], ['metering', 'usage'],
    ],
  },
  {
    key: 'kernel', name: 'Kernel', owner: 'ours — enforced at runtime',
    role: 'Everything true of every B2B SaaS, nothing true of any particular one. Owns no domain entities.',
    chips: [
      ['ctx.sql', ''], ['ctx.emit', ''], ['ctx.check', ''],
      ['ctx.link', ''], ['ctx.grant', ''], ['ctx.now', ''],
    ],
  },
];

const repo = 'https://github.com/substrat-run/substrat';
</script>

<template>
  <div class="mkt">
    <!-- Hero. Breadth first: the guarantees are a clause at the end of the lede,
         not the pitch. -->
    <section class="bleed hero">
      <div class="wrap hero-inner">
        <span class="badge badge-info">
          <span class="dot" />Pre-release 0.x — working end to end on two adapters
        </span>
        <h1>Build almost any business app.</h1>
        <p class="lede">
          Field service, HR, court bookings, a CMS, a coffee shop, a support desk —
          eight demo verticals on one kernel, and three of them compose no engine at
          all. Tenancy, identity, permissions, audit and GDPR come with the
          foundation instead of with your discipline.
        </p>
        <div class="cta-row">
          <a class="btn btn-primary" href="/guide/getting-started">Get started</a>
          <a class="btn btn-secondary" href="/verticals/">See what people build</a>
        </div>
        <div class="cmdline">
          <span class="mono-xs">or</span>
          <code class="cmd">npm create substrat my-app</code>
        </div>
      </div>
      <div class="rule3"><span class="lv" /><span class="le" /><span class="lk" /></div>
    </section>

    <!-- The evidence for the claim, first rather than last. -->
    <section class="wrap section">
      <div class="kicker kicker-vertical">What people build</div>
      <h2>Eight demos. Eight businesses. One foundation.</h2>
      <p class="muted lede-narrow">
        Chosen, not accumulated — each one proves a different way of using the
        platform. The foundation is identical in all eight; the vocabulary, the
        screens and the shape are not.
      </p>
      <div class="grid-4">
        <a v-for="d in demos" :key="d.name" class="vcard" :href="d.href">
          <span class="vhead">
            <i :class="`layer-${d.layer}`" />
            <b>{{ d.name }}</b>
          </span>
          <span class="vdomain">{{ d.domain }}</span>
          <span class="muted sm vbody">{{ d.body }}</span>
          <span class="vfoot" :class="{ kernelonly: d.layer === 'kernel' }">{{ d.uses }}</span>
        </a>
      </div>
      <div class="vlegend">
        <span><i class="layer-kernel" />composes no engine — the kernel alone was enough</span>
        <span><i class="layer-engine" />composes one or more engines</span>
      </div>
    </section>

    <!-- What arrives free. The list is the argument; density is the point. -->
    <section class="bleed band">
      <div class="wrap section">
        <div class="kicker">What arrives with it</div>
        <h2>None of this is a feature you build.</h2>
        <p class="muted lede-narrow">
          Every one of these exists the moment your project does — on the laptop and
          in production, the same code either way. Nothing here is a checkbox on a
          pricing page or a module you install.
        </p>
        <div class="inv">
          <div v-for="[group, items] in inventory" :key="group" class="invcol">
            <div class="invh">{{ group }}</div>
            <div v-for="[title, desc] in items" :key="title" class="invi">
              <span class="c">✓</span>
              <span><b>{{ title }}</b><span class="muted">{{ desc }}</span></span>
            </div>
          </div>
        </div>
        <p class="invnote">
          The list is the argument. Any one of these is a sprint; the identity and
          audit ones are a quarter and a consultant. They are here because the layer
          under your app is the same in every business — which is exactly why nobody
          should be rebuilding it per product.
        </p>
      </div>
    </section>

    <!-- What the code looks like. The point of this section is the SECOND column:
         a landing page that only shows what you write is showing the easy half. -->
    <section class="wrap section">
      <div class="kicker">What you write</div>
      <h2>One operation, whole.</h2>
      <p class="muted lede-narrow">
        This is the entire handler. Everything in the right-hand column happened
        anyway — not because the code asked for it, but because it could not
        avoid it.
      </p>
      <div class="split">
        <div class="codewrap">
          <div class="codetab">demos/callout/src/module.ts</div>
          <pre class="code"><code>{{ sample }}</code></pre>
        </div>
        <ul class="annos">
          <li v-for="([title, desc], i) in didnt" :key="title">
            <span class="anum">{{ String(i + 1).padStart(2, '0') }}</span>
            <span>
              <span class="atitle">{{ title }}</span>
              <span class="muted sm">{{ desc }}</span>
            </span>
          </li>
        </ul>
      </div>
    </section>

    <!-- Three layers, drawn by the same figure the architecture docs use. -->
    <section class="bleed band">
      <div class="wrap section">
        <div class="kicker">The idea in three layers</div>
        <h2>We build the substrate. You build the verticals.</h2>
        <p class="muted lede-narrow">
          The engines in the middle are optional — compose them where your domain
          matches one, and skip them where it doesn’t.
        </p>
        <div class="stack">
          <template v-for="(l, i) in stack" :key="l.name">
            <div class="slayer" :class="`sl-${l.key}`">
              <div>
                <div class="sname">{{ l.name }}</div>
                <div class="muted sm">{{ l.role }}</div>
                <div class="sowner">{{ l.owner }}</div>
              </div>
              <div class="chips">
                <span v-for="[name, sub] in l.chips" :key="name" class="chip">
                  <b>{{ name }}</b><em v-if="sub">{{ sub }}</em>
                </span>
              </div>
            </div>
            <div v-if="i === 0" class="theline">
              <b>THE LINE</b>
              <span>Above ↑ mistakes are cosmetic &nbsp;·&nbsp; ↓ Below mistakes are catastrophic, so they are ours</span>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- Engines as an option, not as architecture for its own sake. -->
    <section class="bleed band-engine">
      <div class="wrap section">
        <div class="kicker kicker-engine">Where a domain already exists</div>
        <h2>Seven engines you don’t have to write.</h2>
        <p class="muted lede-narrow">
          They own the invariants that are the same in every business: a state
          machine that can’t skip, an invoice immutable once exported, a booking
          that can’t double-allocate. <strong>Three of the eight demos above compose
          none at all</strong> — engines are there when your domain matches one, not
          a tax when it doesn’t. And no engine talks to a sibling: with <em>N</em>
          engines talking to the kernel there are <em>N</em> contracts to keep
          compatible; between each other there are <em>N</em>².
        </p>

        <figure class="starbox" role="img"
          aria-label="Seven engines — work orders, bookings, invoicing, protocols, invites, absence and metering — each connected to a central kernel and to nothing else. A crossed-out dashed line between two neighbouring engines marks the edge that never exists.">
          <svg viewBox="0 0 1016 476" aria-hidden="true">
            <g class="spokes">
              <line v-for="n in ring" :key="n.name" :x1="n.cx" :y1="n.cy" x2="508" y2="258" />
            </g>
            <path class="noedge-arc" d="M583,73 Q690,40 774,117" />
          </svg>
          <div v-for="n in ring" :key="n.name" class="enode" :class="{ byevent: n.event }"
            :style="{ left: `${n.x}px`, top: `${n.y}px` }">
            <span class="en"><i />{{ n.name }}</span>
            <span class="em">{{ n.event ? 'by event' : 'by call' }}</span>
          </div>
          <div class="ekernel">
            <b>Kernel</b>
            <span>tenancy · permissions · events · migrations</span>
          </div>
          <div class="noedge">✕</div>
          <div class="noedge-l">no edge, ever</div>
        </figure>

        <div class="legend">
          <span><i class="k" />every engine talks to the kernel, and only to the kernel</span>
          <span><i class="kd" />by event — the vertical emits, the engine consumes</span>
          <span><i class="kx">✕</i>no engine imports, calls or reads a sibling</span>
        </div>
      </div>
    </section>

    <!-- The guarantees, late, as proof rather than as the pitch. -->
    <section class="wrap section">
      <div class="kicker">And underneath all eight</div>
      <h2>Code built on Substrat cannot:</h2>
      <p class="muted lede-narrow">
        None of this depends on the discipline of the code above it — which is the
        point, because increasingly that code is written by an agent.
      </p>
      <div class="ledger">
        <div v-for="([title, desc, tag]) in cannots" :key="title" class="lrow">
          <span class="lx">✕</span>
          <span class="ltitle">{{ title }}</span>
          <span class="muted sm">{{ desc }}</span>
          <span class="ltag">{{ tag }}</span>
        </div>
      </div>
    </section>

    <!-- The depth lives on its own pages; the home page just points at it. -->
    <section class="bleed linkband">
      <div class="wrap linkband-in">
        <span class="linkband-l">Straight answers</span>
        <a href="/guide/comparisons">How Substrat compares</a>
        <a href="/guide/what-substrat-lacks">What Substrat doesn’t have (yet)</a>
        <a href="/guide/faq">FAQ</a>
      </div>
    </section>

    <!-- CTA -->
    <section class="bleed cta">
      <div class="wrap cta-inner">
        <div class="cta-copy">
          <div class="cta-bars">
            <span class="cta-bar layer-vertical" />
            <span class="cta-bar layer-engine" />
            <span class="cta-bar layer-kernel" />
          </div>
          <div class="cta-title">Build the vertical.<br />The substrate holds.</div>
        </div>
        <div class="cta-actions">
          <a class="btn btn-primary" href="/guide/getting-started">Get started</a>
          <a class="btn btn-ondark" :href="repo">View on GitHub</a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Full-bleed helper: break out of VitePress's centered page container so section
   backgrounds span edge to edge, while inner .wrap keeps content at 1080. */
.bleed {
  width: 100vw;
  margin-left: 50%;
  transform: translateX(-50vw);
}
.wrap {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 32px;
}
.section {
  padding: 80px 32px;
}
.muted {
  color: var(--text-secondary);
}
.sm {
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}
.mono-xs {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

h1 {
  font-size: var(--text-4xl);
  line-height: var(--lh-4xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  margin: 0;
  max-width: 780px;
  text-wrap: balance;
  border: 0;
  padding: 0;
}
h2 {
  font-size: var(--text-2xl);
  line-height: var(--lh-2xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  margin: 0;
  border: 0;
  padding: 0;
}
.kicker {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-brand);
  font-weight: var(--weight-semibold);
  margin-bottom: 10px;
}
.kicker-engine {
  color: var(--layer-engine);
}
.kicker-vertical {
  color: var(--layer-vertical);
}

/* Hero */
.hero {
  border-bottom: 1px solid var(--border-subtle);
  /* theme-aware wash — the prototype hardcoded --brand-50, light-only */
  background: linear-gradient(180deg, var(--surface-brand-subtle) 0%, var(--surface-card) 70%);
}
.hero-inner {
  padding: 92px 32px 84px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 20px;
}
.lede {
  font-size: var(--text-lg);
  line-height: var(--lh-lg);
  color: var(--text-secondary);
  max-width: 640px;
  margin: 0;
}
.lede-narrow {
  max-width: 660px;
  margin-top: 12px;
}
.cta-row {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 6px;
  flex-wrap: wrap;
}
.cmdline {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cmd {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 8px 13px;
  color: var(--text-secondary);
}

/* The layer through-line: a three-colour rule closing the hero. */
.rule3 {
  display: flex;
  height: 3px;
}
.rule3 span {
  flex: 1;
}
.lv {
  background: var(--layer-vertical);
}
.le {
  background: var(--layer-engine);
}
.lk {
  background: var(--layer-kernel);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  height: var(--control-h-lg);
  padding: 0 18px;
  border-radius: var(--radius-sm);
  font-weight: var(--weight-medium);
  font-size: var(--text-base);
  text-decoration: none;
  transition: background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.btn-primary {
  background: var(--action-primary-bg);
  color: var(--action-primary-text);
  box-shadow: var(--shadow-xs);
}
.btn-primary:hover {
  background: var(--action-primary-bg-hover);
  text-decoration: none;
}
.btn-secondary {
  background: var(--surface-card);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-xs);
}
.btn-secondary:hover {
  border-color: var(--border-strong);
  text-decoration: none;
}
.btn-ondark {
  background: transparent;
  color: #f2f3f7;
  border: 1px solid #343a50;
}
.btn-ondark:hover {
  border-color: #4a5170;
  text-decoration: none;
}

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  padding: 2px 10px;
  border-radius: var(--radius-full);
}
.badge .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-info-dot);
}
.badge-info {
  background: var(--status-info-bg);
  color: var(--status-info-fg);
}

/* Bands alternate the page surface behind a section */
.band {
  background: var(--surface-page);
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}
/* The engine layer gets its own accent band — --cyan-50 in light, the dark
   theme's info surface in dark. Both are token values, not derived tints. */
.band-engine {
  background: var(--status-info-bg);
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

/* Layer accents */
.layer-kernel {
  background: var(--layer-kernel);
}
.layer-engine {
  background: var(--layer-engine);
}
.layer-vertical {
  background: var(--layer-vertical);
}

/* Eight demos */
.grid-4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-top: 32px;
}
.vcard {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-sm);
  padding: 16px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: inherit;
  text-decoration: none;
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.vcard:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  text-decoration: none;
}
.vhead {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vhead i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.vhead b {
  font-size: var(--text-base);
  line-height: var(--lh-base);
  font-weight: var(--weight-semibold);
}
.vdomain {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  color: var(--text-tertiary);
}
.vbody {
  flex: 1;
}
.vfoot {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  color: var(--text-tertiary);
  padding-top: 9px;
  border-top: 1px solid var(--border-subtle);
}
.vfoot.kernelonly {
  color: var(--layer-kernel);
}
.vlegend {
  display: flex;
  gap: 26px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 22px;
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  color: var(--text-secondary);
}
.vlegend span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.vlegend i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

/* What arrives with it */
.inv {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 28px;
  margin-top: 34px;
}
.invcol {
  display: flex;
  flex-direction: column;
}
.invh {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
  padding-bottom: 10px;
  border-bottom: 2px solid var(--layer-kernel);
  margin-bottom: 4px;
}
.invcol:nth-child(2) .invh {
  border-bottom-color: var(--layer-engine);
}
.invcol:nth-child(3) .invh {
  border-bottom-color: var(--layer-vertical);
}
.invcol:nth-child(4) .invh {
  border-bottom-color: var(--text-tertiary);
}
.invi {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 8px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}
.invi:last-child {
  border-bottom: 0;
}
.invi .c {
  color: var(--status-success-fg);
  font-size: var(--text-xs);
  padding-top: 3px;
}
.invi b {
  font-weight: var(--weight-semibold);
  display: block;
}
.invnote {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--border-default);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  color: var(--text-secondary);
  max-width: 780px;
}

/* Code sample beside what it did NOT have to say */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 32px;
  margin-top: 32px;
  align-items: start;
}
.codewrap {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  background: var(--surface-page);
}
.codetab {
  padding: 9px 16px;
  border-bottom: 1px solid var(--border-default);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  background: var(--surface-inset);
}
.code {
  margin: 0;
  padding: 18px 20px;
  overflow-x: auto;
  font-size: var(--text-sm);
  line-height: 1.7;
  background: none;
}
.code code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre;
  background: none;
  padding: 0;
  border: 0;
  color: var(--text-primary);
}
.annos {
  list-style: none;
  margin: 0;
  padding: 0;
}
.annos li {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 12px;
  padding: 13px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.annos li:first-child {
  padding-top: 0;
}
.annos li:last-child {
  border-bottom: 0;
}
.anum {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--layer-kernel);
  padding-top: 2px;
}
.atitle {
  font-weight: var(--weight-semibold);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  display: block;
  margin-bottom: 3px;
}

/* The three-layer stack. Each band carries its layer accent on the left edge,
   so the page's colour through-line and the architecture agree. */
.stack {
  margin-top: 32px;
  display: flex;
  flex-direction: column;
}
.slayer {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 24px;
  padding: 20px 22px;
  border: 1px solid var(--border-default);
  border-left-width: 4px;
  background: var(--surface-card);
  box-shadow: var(--shadow-sm);
}
.slayer:first-of-type {
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}
.slayer:last-of-type {
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}
.slayer + .slayer {
  border-top: 0;
}
.sl-vertical {
  border-left-color: var(--layer-vertical);
}
.sl-engine {
  border-left-color: var(--layer-engine);
}
.sl-kernel {
  border-left-color: var(--layer-kernel);
}
.sname {
  font-size: var(--text-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
  margin-bottom: 4px;
}
.sowner {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  color: var(--text-tertiary);
  margin-top: 6px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  align-content: flex-start;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  background: var(--surface-inset);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
}
.chip b {
  font-weight: var(--weight-medium);
}
.chip em {
  font-style: normal;
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}
.theline {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 22px;
  background: var(--surface-inset);
  border-left: 4px solid var(--border-strong);
  border-right: 1px solid var(--border-default);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.theline b {
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
}

/* The engine ring. Node boxes are opaque and sit above the spokes, so a line
   drawn to the kernel's centre is covered at both ends and reads as an edge
   between two boxes. */
.starbox {
  position: relative;
  width: 1016px;
  max-width: 100%;
  height: 476px;
  margin: 32px 0 0;
}
.starbox svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.spokes line {
  stroke: var(--border-strong);
  stroke-width: 1;
}
.noedge-arc {
  fill: none;
  stroke: var(--status-danger-fg);
  stroke-width: 1.5;
  stroke-dasharray: 4 4;
}
.enode {
  position: absolute;
  width: 150px;
  height: 52px;
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 12px;
  gap: 2px;
}
.enode .en {
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  font-weight: var(--weight-semibold);
  display: flex;
  align-items: center;
  gap: 7px;
}
.enode .en i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--layer-engine);
  flex: none;
}
.enode .em {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  color: var(--text-tertiary);
  padding-left: 13px;
}
.enode.byevent {
  border-style: dashed;
  border-color: var(--layer-engine);
}
.ekernel {
  position: absolute;
  left: 398px;
  top: 210px;
  width: 220px;
  height: 96px;
  background: var(--surface-brand-subtle);
  border: 1px solid var(--layer-kernel);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 5px;
}
.ekernel b {
  font-size: var(--text-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
}
.ekernel span {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  color: var(--text-secondary);
  text-align: center;
  max-width: 180px;
}
.noedge {
  position: absolute;
  left: 671px;
  top: 54px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.noedge-l {
  position: absolute;
  left: 706px;
  top: 32px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  color: var(--status-danger-fg);
}
.legend {
  display: flex;
  gap: 28px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--border-subtle);
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  color: var(--text-secondary);
}
.legend i.k {
  width: 26px;
  border-top: 1px solid var(--border-strong);
  flex: none;
}
.legend i.kd {
  width: 26px;
  border-top: 1px dashed var(--layer-engine);
  flex: none;
}
.legend i.kx {
  font-style: normal;
  color: var(--status-danger-fg);
  font-weight: var(--weight-semibold);
}

/* The guarantees, as a ledger rather than a card grid. */
.ledger {
  margin-top: 32px;
  border-top: 1px solid var(--border-default);
}
.lrow {
  display: grid;
  grid-template-columns: 34px minmax(0, 300px) minmax(0, 1fr) 148px;
  gap: 20px;
  align-items: start;
  padding: 20px 0;
  border-bottom: 1px solid var(--border-default);
}
.lx {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.ltitle {
  font-size: var(--text-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
}
.ltag {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
  color: var(--text-tertiary);
  text-align: right;
  padding-top: 4px;
}

/* The depth lives elsewhere; this is a signpost, not an argument. */
.linkband {
  background: var(--surface-page);
  border-top: 1px solid var(--border-subtle);
}
.linkband-in {
  padding: 32px;
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.linkband-l {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-tertiary);
}
.linkband a {
  font-size: var(--text-base);
  color: var(--text-primary);
  text-decoration: none;
  border-bottom: 1px solid var(--border-strong);
  padding-bottom: 1px;
}
.linkband a:hover {
  border-bottom-color: var(--text-primary);
}

/* CTA */
.cta {
  background: var(--gray-950);
}
.cta-inner {
  padding: 56px 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 40px;
  flex-wrap: wrap;
}
.cta-bars {
  display: flex;
  gap: 5px;
  margin-bottom: 16px;
}
.cta-bar {
  width: 26px;
  height: 4px;
  border-radius: 2px;
}
.cta-title {
  font-size: var(--text-3xl);
  line-height: var(--lh-3xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: #f2f3f7;
}
.cta-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

/* Narrow screens: the four-column grids and the fixed-size ring are the two
   things that cannot survive a phone, so they collapse rather than scroll. */
@media (max-width: 960px) {
  .grid-4,
  .inv {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .split,
  .slayer {
    grid-template-columns: minmax(0, 1fr);
  }
  .lrow {
    grid-template-columns: 28px minmax(0, 1fr);
  }
  .lrow .ltag {
    display: none;
  }
  .starbox {
    height: auto;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .starbox svg,
  .starbox .noedge,
  .starbox .noedge-l {
    display: none;
  }
  .starbox .enode,
  .starbox .ekernel {
    position: static;
    width: auto;
    height: auto;
    padding: 12px;
  }
  .starbox .ekernel {
    grid-column: 1 / -1;
    order: -1;
    align-items: flex-start;
  }
  .starbox .ekernel span {
    text-align: left;
  }
}
@media (max-width: 640px) {
  .grid-4,
  .inv,
  .starbox {
    grid-template-columns: minmax(0, 1fr);
  }
  .section {
    padding: 56px 24px;
  }
}
</style>
