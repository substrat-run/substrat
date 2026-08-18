<script setup lang="ts">
// The marketing landing page, ported from the design handoff's React prototype
// (handoff/website/home-page.jsx). It renders inside VitePress's `layout: page`,
// so the nav and footer are VitePress's own shared chrome — not rebuilt here.
//
// Content is deliberately faithful to the prototype; every factual claim
// (package status, demo names, the `pnpm create substrat` command) was checked
// against the repo before porting. Links point at real docs routes or the repo.

const layers = [
  {
    key: 'kernel',
    name: 'Kernel',
    desc: 'Everything true of every B2B SaaS, nothing true of any particular one: identity, nested tenancy, permissions, events & audit, GDPR machinery. Owns no domain entities.',
  },
  {
    key: 'engine',
    name: 'Engines',
    desc: 'Shared domain machinery — work orders, invoicing, protocols — that owns invariants: state machines can’t skip states, exported invoices are immutable, every mutation emits an event.',
  },
  {
    key: 'vertical',
    name: 'Verticals',
    desc: 'The actual products — your code. Vocabulary, workflows, screens, pricing. The layer where AI tools do their best work, because mistakes there are cosmetic.',
  },
];

const cannots = [
  [
    'Reach another tenant’s data',
    'Data access only exists as capability-scoped operations minted for one (tenant, scope) pair — a mismatch fails closed.',
  ],
  [
    'Skip the audit log',
    'Events are stamped with tenant, scope, actor, and timestamp below the API surface. Calling code cannot forge or suppress them.',
  ],
  [
    'Emit unclassified PII',
    'Every event carries a mandatory piiClass; a PII-classed event without a data-subject key fails validation, so GDPR erasure is always possible.',
  ],
  [
    'Bypass the permission model',
    'Operations run inside the scope’s execution domain; every allow carries the proof path that granted it. The secure default is deny everything.',
  ],
];

const ops = [
  [
    'Test copies of any app',
    'Snapshot a running app’s data into an independent copy — try the risky thing on real data, then throw the copy away. Copies expire on a TTL and are reaped automatically.',
    '/concepts/snapshots',
  ],
  [
    'Fearless upgrades',
    'An update that changes the schema snapshots the data first, automatically — so a bad migration has a rollback point. A code-only update just rebinds.',
    '/concepts/snapshots#the-one-rule-everything-follows',
  ],
  [
    'Real data on your laptop, governed',
    'substrat scope pull writes a real SQLite file your local harness runs unchanged — audited, jurisdiction-checked, and masked by default. Full fidelity is an explicit break-glass.',
    '/concepts/snapshots#where-the-data-goes-and-doesn-t',
  ],
];

const demos = [
  ['RallyPoint', 'Padel club', 'engine', 'Court booking as allocation over an interval rather than a state machine — the lost race rejected with no locking code anywhere, multi-venue tenancy, and a player who holds no role at all reaching their own booking through an entity-narrowed grant.', '/verticals/rallypoint'],
  ['Meridian', 'HR', 'kernel', 'The shape-breaker: no engine exists for its core domain, so leave, time and expenses are vertical code on the kernel alone. Multi-country scopes diverging from one codebase, and one role-adaptive app serving employee and manager in the same surface.', '/verticals/meridian'],
  ['Callout', 'Field service', 'vertical', 'The canonical composition — a Swedish service & installation firm where two engines cooperate through events with zero imports between them. Runs on SQLite locally and deployed on Cloudflare from one codebase.', '/verticals/'],
];

const pkgs = [
  ['@substrat-run/contracts', 'Zod contract schemas — the source of truth', 'Working'],
  ['@substrat-run/kernel', 'Scope-host contract + tuple permission checker', 'Working'],
  ['@substrat-run/adapter-sqlite', 'Pure-SQLite scope host — local dev, CI, self-host', 'Working'],
  ['@substrat-run/adapter-cloudflare', 'Durable-Object scope host — production', 'Working'],
  ['@substrat-run/contract-tests', 'The conformance suite both adapters pass unchanged', 'Working'],
  ['@substrat-run/model-emit', 'DDL emitted from your declared entities, and the reader that checks it', 'Working'],
  ['@substrat-run/vertical-host', 'The platform surface a hosted vertical mounts', 'Working'],
  ['@substrat-run/cli', 'substrat login / push — authenticated deploy', 'Working'],
  ['@substrat-run/engine-workorder', 'Work orders, time & material', 'Seed'],
  ['@substrat-run/engine-booking', 'Reservations — resource × interval, one allocation invariant, no locks', 'Seed'],
  ['@substrat-run/engine-invoicing', 'Invoice basis, immutable exports', 'Seed'],
  ['@substrat-run/engine-protocol', 'Checklists & protocols', 'Seed'],
  ['@substrat-run/engine-invites', 'Invitations — verified hashed identifier, accept-required', 'Seed'],
  ['@substrat-run/engine-absence', 'Leave and absence — balances as an entry ledger', 'Seed'],
  ['@substrat-run/engine-metering', 'Usage readings folded into billable meters', 'Seed'],
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
  if (!facility) throw new Error(\`facility not found: \${input.facilityId}\`);

  return createWorkOrder(ctx, {          // the engine's in-scope function,
    facility: ref('facility', facility.id),   // inside YOUR transaction
    customer: ref('customer', facility.customer_id),
    kind: input.kind,
    title: input.title,
  });
};`;

const didnt = [
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

// Why an agent is a primary user of this API, not an afterthought.
const forAgents = [
  [
    'Derived, not generated',
    'Entities are declared once; the DDL and the model artifact are emitted by code, and CI fails on drift. Cheaper than a model in tokens, latency and exactness — and smaller to hold in context afterwards.',
    '/concepts/model',
  ],
  [
    'An oracle the build didn’t write',
    'Code comes from the model; tests come from the human-approved concept. Two independent derivations, and the disagreement between them is the product. A suite written after the handlers can only agree with whatever got built.',
    '/guide/ai-agents#the-second-opinion-two-descriptions-that-can-disagree',
  ],
  [
    'Bring your own model',
    'Design and build run in your agent — Claude Code, Cursor, opencode — against skills that ship in the project. Your tokens, your model, and a repo that boots on SQLite with no platform in the loop.',
    '/guide/ai-agents#bring-your-own-model-bring-your-own-agent',
  ],
  [
    'Every PR gets a copy of production',
    'Open a pull request and the platform forks the production scope, runs that PR’s own migrations against the copy, and posts the URL. Reviewing a migration diff is a checkpoint; watching it run on real data is what makes it honest.',
    '/guide/environments-and-previews',
  ],
];

const repo = 'https://github.com/substrat-run/substrat';
</script>

<template>
  <div class="mkt">
    <!-- Hero -->
    <section class="bleed hero">
      <div class="wrap hero-inner">
        <span class="badge badge-info">
          <span class="dot" />Pre-release 0.x — working end to end on two adapters
        </span>
        <h1>The hard parts, hosted.</h1>
        <p class="lede">
          AI made building vertical B2B software fast — except multi-tenancy,
          identity, permissions, audit, and GDPR. Substrat owns those parts and
          enforces them at runtime, so small teams can build production-grade
          SaaS on top without the speed being fatal.
        </p>
        <div class="cta-row">
          <a class="btn btn-primary" href="/guide/getting-started">Get started</a>
          <a class="btn btn-secondary" href="/guide/why-substrat">Why runtime enforcement</a>
          <code class="cmd">npm create substrat my-app</code>
        </div>
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
        <pre class="code"><code>{{ sample }}</code></pre>
        <ul class="didnt">
          <li v-for="([title, desc]) in didnt" :key="title">
            <span class="didnt-title">{{ title }}</span>
            <span class="muted sm">{{ desc }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- Three layers -->
    <section class="wrap section">
      <div class="kicker">The idea in three layers</div>
      <h2>We build the substrate. You build the verticals.</h2>
      <div class="grid-3">
        <div v-for="l in layers" :key="l.key" class="layer-card">
          <div class="layer-bar" :class="`layer-${l.key}`" />
          <div class="layer-body">
            <div class="layer-head">
              <span class="layer-name">{{ l.name }}</span>
              <code class="tag">--layer-{{ l.key }}</code>
            </div>
            <p class="muted">{{ l.desc }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Enforced at runtime -->
    <section class="bleed band">
      <div class="wrap section">
        <div class="kicker">Enforced at runtime</div>
        <h2>Code built on Substrat cannot:</h2>
        <p class="muted lede-narrow">
          None of this depends on the discipline of the code above it — which is
          the point, because increasingly that code is written by an agent.
        </p>
        <div class="grid-2">
          <div v-for="([title, desc]) in cannots" :key="title" class="cannot">
            <span class="x">✕</span>
            <div>
              <div class="cannot-title">{{ title }}</div>
              <div class="muted sm">{{ desc }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Day-2 operations -->
    <section class="wrap section">
      <div class="kicker">Day-2 operations, day one</div>
      <h2>The ops a platform team would build — built in.</h2>
      <p class="muted lede-narrow">
        Every app is one tenant’s scope with its own database, so the operations
        story is a platform primitive, not a runbook.
      </p>
      <div class="grid-2">
        <a v-for="([title, desc, href]) in ops" :key="title" class="cannot op" :href="href">
          <span class="check">✓</span>
          <div>
            <div class="cannot-title">{{ title }}</div>
            <div class="muted sm">{{ desc }}</div>
          </div>
        </a>
      </div>
    </section>

    <!-- Built for agents -->
    <section class="bleed band">
      <div class="wrap section">
        <div class="kicker">Built for agents, on purpose</div>
        <h2>The layer AI is worst at is the layer that’s already written.</h2>
        <p class="muted lede-narrow">
          Tenancy, auth, migrations and compliance are where models fail and where
          failure is catastrophic. Screens, forms and workflows are where they excel
          and where failure is cosmetic. Substrat draws the line between them and
          enforces it — then does four more things most “AI-friendly” claims skip.
        </p>
        <div class="grid-2">
          <a v-for="([title, desc, href]) in forAgents" :key="title" class="cannot op" :href="href">
            <span class="check">✓</span>
            <div>
              <div class="cannot-title">{{ title }}</div>
              <div class="muted sm">{{ desc }}</div>
            </div>
          </a>
        </div>
      </div>
    </section>

    <!-- Reference verticals -->
    <section class="wrap section">
      <div class="kicker">Reference verticals</div>
      <h2>The same kernel, three businesses.</h2>
      <div class="grid-3">
        <a v-for="([name, kind, layer, desc, href]) in demos" :key="name" class="demo-card" :href="href">
          <div class="demo-head">
            <span class="swatch" :class="`layer-${layer}`" />
            <span class="demo-name">{{ name }}</span>
            <span class="demo-kind">{{ kind }}</span>
          </div>
          <p class="muted sm">{{ desc }}</p>
        </a>
      </div>
    </section>

    <!-- Current status -->
    <section class="bleed band">
      <div class="wrap section">
        <div class="kicker">Current status</div>
        <h2>What exists today</h2>
        <div class="pkg-table">
          <div v-for="([pkg, desc, status]) in pkgs" :key="pkg" class="pkg-row">
            <code class="pkg-name">{{ pkg }}</code>
            <span class="muted sm pkg-desc">{{ desc }}</span>
            <span class="badge" :class="status === 'Working' ? 'badge-success' : 'badge-neutral'">
              {{ status.toLowerCase() }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- The honest half. A page that only lists strengths is a document nobody
         trusts twice — so the gaps get a section, not a footnote. -->
    <section class="wrap section">
      <div class="kicker">The honest half</div>
      <h2>Where Substrat is the wrong answer.</h2>
      <p class="muted lede-narrow">
        Single-tenant internal tools, one scale-heavy tenant, deep-domain products
        like payroll or core banking, and anything where the foundation isn’t your
        binding constraint — reach for something else, and the docs will say so
        rather than sell around it.
      </p>
      <p class="muted lede-narrow">
        There is also a list of what we don’t have: one production connector, no
        certifications yet, no search, no localization, no report builder. Almost
        every gap is breadth; almost every strength is depth of guarantee. That’s
        the honest shape of a young platform, and it says plainly who shouldn’t
        buy yet.
      </p>
      <div class="cta-row">
        <a class="btn btn-secondary" href="/guide/what-substrat-lacks">What Substrat doesn’t have (yet)</a>
        <a class="btn btn-secondary" href="/guide/comparisons">How Substrat compares</a>
        <a class="btn btn-secondary" href="/guide/faq">FAQ</a>
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

h1 {
  font-size: var(--text-4xl);
  line-height: var(--lh-4xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  margin: 0;
  max-width: 640px;
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
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-brand);
  font-weight: var(--weight-semibold);
  margin-bottom: 10px;
}

/* Hero */
.hero {
  border-bottom: 1px solid var(--border-subtle);
  /* theme-aware wash — the prototype hardcoded --brand-50, light-only */
  background: linear-gradient(180deg, var(--surface-brand-subtle) 0%, var(--surface-card) 70%);
}
.hero-inner {
  padding: 96px 32px 88px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 20px;
}
.lede {
  font-size: var(--text-lg);
  line-height: var(--lh-lg);
  color: var(--text-secondary);
  max-width: 620px;
  margin: 0;
}
.lede-narrow {
  max-width: 620px;
  margin-top: 10px;
}
.cta-row {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 6px;
  flex-wrap: wrap;
}
.cmd {
  margin-left: 10px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  color: var(--text-secondary);
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
.badge-success {
  background: var(--status-success-bg);
  color: var(--status-success-fg);
}
.badge-neutral {
  background: var(--status-neutral-bg);
  color: var(--status-neutral-fg);
}

/* Bands alternate the page surface behind a section */
.band {
  background: var(--surface-page);
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

/* Grids */
.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin-top: 32px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 28px;
}

/* Code sample beside what it did NOT have to say */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 28px;
  margin-top: 32px;
  align-items: start;
}
.code {
  margin: 0;
  padding: 20px 22px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--surface-page);
  box-shadow: var(--shadow-sm);
  overflow-x: auto;
  font-size: var(--text-sm);
  line-height: 1.65;
}
.code code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre;
  background: none;
  padding: 0;
  border: 0;
  color: var(--text-primary);
}
.didnt {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.didnt li {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 16px;
  border-left: 2px solid var(--border-default);
}
.didnt-title {
  font-weight: var(--weight-semibold);
  font-size: var(--text-sm);
}

/* Three-layer cards */
.layer-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  background: var(--surface-card);
}
.layer-bar {
  height: 4px;
}
.layer-body {
  padding: 20px 20px 22px;
}
.layer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.layer-name {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}
.tag {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  padding: 1px 6px;
}

/* Cannots */
.cannot {
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 16px 18px;
  display: flex;
  gap: 12px;
}
.x {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--status-danger-fg);
  font-weight: var(--weight-medium);
  margin-top: 1px;
}
.check {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--status-success-fg);
  font-weight: var(--weight-medium);
  margin-top: 1px;
}
.op {
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s ease;
}
.op:hover {
  border-color: var(--border-strong);
}
.cannot-title {
  font-weight: var(--weight-semibold);
  margin-bottom: 4px;
}

/* Demo cards — each links to that vertical's page */
.demo-card {
  display: block;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--shadow-xs);
  background: var(--surface-card);
  color: var(--text-primary);
  transition: border-color 0.15s ease;
}
.demo-card:hover {
  border-color: var(--border-strong);
  text-decoration: none;
}
.demo-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.demo-name {
  font-weight: var(--weight-semibold);
}
.demo-kind {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  margin-left: auto;
}

/* Package table */
.pkg-table {
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  margin-top: 28px;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}
.pkg-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 18px;
}
.pkg-row + .pkg-row {
  border-top: 1px solid var(--border-subtle);
}
.pkg-name {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  width: 300px;
  color: var(--text-primary);
}
.pkg-desc {
  flex: 1;
}

/* CTA */
.cta {
  background: var(--gray-950);
}
.cta-inner {
  padding: 72px 32px;
  display: flex;
  align-items: center;
  gap: 24px;
}
.cta-copy {
  flex: 1;
}
.cta-bars {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
}
.cta-bar {
  width: 22px;
  height: 5px;
  border-radius: 3px;
}
.cta-title {
  font-size: var(--text-3xl);
  line-height: var(--lh-3xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  color: #f2f3f7;
}
.cta-actions {
  display: flex;
  gap: 12px;
}

/* Responsive */
@media (max-width: 900px) {
  .grid-3 {
    grid-template-columns: 1fr;
  }
  .grid-2 {
    grid-template-columns: 1fr;
  }
  .split {
    grid-template-columns: 1fr;
  }
  .cta-inner {
    flex-direction: column;
    align-items: flex-start;
  }
  .pkg-name {
    width: auto;
  }
  .pkg-row {
    flex-wrap: wrap;
  }
}
</style>
