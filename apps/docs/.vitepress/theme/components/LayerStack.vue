<script setup lang="ts">
// The three-layer model as a stratified diagram: verticals above the line,
// engines + kernel + adapters below it, connectors at the edge. Every label is a
// real, shipping package; the chip copy is checked against the repo. Colors come
// from the design tokens' --layer-* accents (kernel indigo, engine cyan, vertical
// amber) so this reads the same as the rest of the docs and flips with the theme.

const verticals = [
  ['Callout', 'field service'],
  ['RallyPoint', 'padel club'],
  ['Handlebar', 'bike workshop'],
  ['Kallkälla', 'coffee shop'],
  ['Meridian', 'HR'],
  ['Manyfold', 'headless CMS'],
];

const engines = [
  ['workorder', 'one state machine · append-only time + material'],
  ['booking', 'resource × interval × capacity · one allocation, no locks'],
  ['invoicing', 'consumes billable events · immutable once exported'],
  ['protocol', 'checklists + signed docs · freeze → immutable, hashed'],
  ['invites', 'hashed identifier · accept-required · non-enumerable'],
];

const kernelBits = [
  'Identity', 'Nested tenancy', 'Permissions + grants', 'Events / audit spine',
  'Migrations', 'GDPR machinery', 'Notifications', 'Jobs',
  'Billing entitlements', 'Module system', 'Attachment contracts', 'App shell',
];

const adapters = [
  ['adapter-sqlite', 'dev · CI · self-host / escrow'],
  ['adapter-cloudflare', 'production · Durable-Object per scope'],
  ['adapter-email', 'notification transport · CF Email + mock'],
];

const laws = [
  ['Kernel owns no domain entities.', 'It provides the spine; verticals define what the entities mean.'],
  ['Star topology.', 'Engines cooperate through fat events and opaque refs — never by importing each other. N contracts, not N².'],
  ['Enforced at runtime.', 'Guarantees are defaults of the substrate, not config a builder — human or AI — can get wrong.'],
  ['No forking.', 'If a vertical ever needs to fork an engine, the engine drew its line wrong.'],
];
</script>

<template>
  <div class="layerstack">
    <!-- Verticals -->
    <section class="layer layer--vertical">
      <div class="rail">
        <p class="lname">Verticals</p>
        <p class="lrole">Everything a user touches — the businesses themselves.</p>
        <p class="lowner">own vocabulary · screens · pricing · roles</p>
      </div>
      <div class="chips">
        <span v-for="[name, sub] in verticals" :key="name" class="chip">
          <b>{{ name }}</b><em>{{ sub }}</em>
        </span>
      </div>
    </section>

    <!-- The line -->
    <div class="theline"><span>the line</span></div>
    <div class="sides">
      <span class="up"><b>Above ↑</b> AI velocity — mistakes are cosmetic (a wrong screen)</span>
      <span class="down"><b>↓ Below</b> humans + runtime guarantees — mistakes are catastrophic (a tenant leak)</span>
    </div>
    <p class="seam">composes engines in-scope, same transaction</p>

    <!-- Engines -->
    <section class="layer layer--engine">
      <div class="rail">
        <p class="lname">Engines</p>
        <p class="lrole">Headless domain machinery that owns invariants. Star topology — they talk to the kernel, never to each other.</p>
        <p class="lowner">own invariants · versioned · never forked</p>
      </div>
      <div class="chips">
        <span v-for="[name, sub] in engines" :key="name" class="chip">
          <b>{{ name }}</b><em>{{ sub }}</em>
        </span>
      </div>
    </section>

    <p class="seam"><b>↓</b> ctx (sql · check · emit · link) &nbsp;·&nbsp; events + audit <b>↑</b></p>

    <!-- Kernel -->
    <section class="layer layer--kernel bedrock">
      <div class="rail">
        <p class="lname">Kernel</p>
        <p class="lrole">The substrate. Everything true of <em>every</em> B2B SaaS — and nothing true of any one.</p>
        <p class="lowner">owns no domain entities</p>
      </div>
      <div>
        <div class="chips kbits">
          <span v-for="b in kernelBits" :key="b" class="kchip">{{ b }}</span>
        </div>
        <div class="ctx">
          <span class="ctxlabel">Every operation runs inside</span>
          <code>ctx.sql</code><code>ctx.check</code><code>ctx.emit</code><code>ctx.link</code>
        </div>
        <p class="knote">No customer table, no work-order table. It offers attachment contracts that bind to opaque (entityType, entityId) refs the vertical defines.</p>
      </div>
    </section>

    <p class="seam">same kernel semantics on any ground — <b>one contract-test suite</b> gates them all</p>

    <!-- Adapters -->
    <section class="layer layer--adapter">
      <div class="rail">
        <p class="lname">Adapters</p>
        <p class="lrole">Scope hosts — the interchangeable ground the kernel is seated on.</p>
        <p class="lowner">swappable · escrowable · self-hostable</p>
      </div>
      <div class="chips">
        <span v-for="[name, sub] in adapters" :key="name" class="chip">
          <b>{{ name }}</b><em>{{ sub }}</em>
        </span>
      </div>
    </section>

    <!-- Connectors -->
    <section class="layer layer--connector edge">
      <div class="rail">
        <p class="lname">Connectors</p>
        <p class="lrole">The outside world, at the edges. React to events on the spine — host code, never module code.</p>
        <p class="lowner">no fetch inside a module — ever</p>
      </div>
      <div class="chips">
        <span class="chip"><b>Scrive eSign</b><em>signatures-requested → BankID signing → recorded back</em></span>
        <span class="chip"><b>…more</b><em>one port per capability</em></span>
      </div>
    </section>

    <!-- Laws -->
    <div class="laws">
      <p class="lawshead">The four rules that hold it together</p>
      <ol>
        <li v-for="([head, body], i) in laws" :key="i">
          <span class="n">{{ i + 1 }}</span>
          <span><b>{{ head }}</b> {{ body }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.layerstack {
  display: flex;
  flex-direction: column;
  margin: 24px 0 8px;
  font-family: var(--font-sans);
}

.layer {
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 20px;
  border: 1px solid var(--border-default);
  border-left: 3px solid var(--accent, var(--border-strong));
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--surface-card);
}
.layer--vertical { --accent: var(--layer-vertical); }
.layer--engine   { --accent: var(--layer-engine); }
.layer--kernel   { --accent: var(--layer-kernel); }
.layer--adapter  { --accent: var(--text-tertiary); }
.layer--connector { --accent: var(--layer-vertical); border-style: dashed; }

.rail { min-width: 0; }
.lname {
  font-size: var(--text-lg);
  line-height: var(--lh-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--accent);
  margin: 0 0 4px;
}
.lrole { font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-secondary); margin: 0 0 8px; }
.lrole em { color: var(--text-primary); font-style: italic; }
.lowner { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; font-weight: var(--weight-semibold); color: var(--text-tertiary); margin: 0; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; }
.chip {
  display: flex; flex-direction: column; gap: 1px;
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 7px 10px;
  min-width: 0;
}
.chip b { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-primary); }
.layer--engine .chip b { color: var(--layer-engine); }
.chip em { font-size: var(--text-xs); line-height: var(--lh-xs); color: var(--text-tertiary); font-style: normal; }

/* Kernel — bedrock treatment. Pinned to a constant deep scale value (not the
   theme-flipping --surface-inverse, which goes near-white in dark mode and would
   swallow the white text). Bedrock reads dark in both themes, by design. */
.bedrock { background: var(--gray-900); border-color: var(--gray-800); }
.bedrock .lname { color: #fff; }
.bedrock .lrole { color: rgba(255,255,255,.82); }
.bedrock .lrole em { color: #fff; }
.bedrock .lowner { color: rgba(255,255,255,.55); }
.kbits { gap: 6px; }
.kchip {
  font-size: var(--text-sm);
  color: rgba(255,255,255,.9);
  background: rgba(255,255,255,.07);
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 7px;
  padding: 5px 9px;
}
.ctx { margin-top: 11px; padding-top: 11px; border-top: 1px dashed rgba(255,255,255,.18); display: flex; flex-wrap: wrap; gap: 7px 14px; align-items: baseline; }
.ctxlabel { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: rgba(255,255,255,.55); font-weight: var(--weight-semibold); }
.ctx code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: #fff;
  background: rgba(255,255,255,.12);
  padding: 1px 7px;
  border-radius: 5px;
}
.knote { margin: 11px 0 0; font-size: var(--text-sm); line-height: var(--lh-sm); color: rgba(255,255,255,.62); font-style: italic; }

/* The line */
.theline { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 14px; margin: 10px 2px; }
.theline::before, .theline::after { content: ""; border-top: 2px dashed var(--layer-vertical); opacity: .5; }
.theline span { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--layer-vertical); font-weight: var(--weight-bold); }
.sides { display: flex; justify-content: space-between; gap: 14px; margin: 0 4px; font-size: var(--text-sm); line-height: var(--lh-sm); color: var(--text-tertiary); }
.sides .down { text-align: right; }
.sides .up b { color: var(--layer-vertical); }
.sides .down b { color: var(--layer-engine); }

.seam { text-align: center; font-size: var(--text-xs); color: var(--text-tertiary); margin: 6px 0; }
.seam b { color: var(--text-secondary); font-weight: var(--weight-semibold); }

/* Laws */
.laws { margin-top: 26px; }
.lawshead { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; font-weight: var(--weight-bold); color: var(--text-primary); margin: 0 0 14px; }
.laws ol { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
.laws li { display: grid; grid-template-columns: 22px 1fr; gap: 10px; font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-secondary); }
.laws .n { font-weight: var(--weight-bold); color: var(--layer-kernel); font-variant-numeric: tabular-nums; }
.laws b { color: var(--text-primary); font-weight: var(--weight-semibold); }

@media (max-width: 640px) {
  .layer { grid-template-columns: 1fr; gap: 12px; }
  .laws ol { grid-template-columns: 1fr; }
  .sides { flex-direction: column; gap: 4px; }
  .sides .down { text-align: left; }
}
</style>
