<script setup lang="ts">
// The runtime topology: how a request travels from a hostname through the router
// to a scope, and the three per-tenant/per-scope databases behind it. Every box is
// a Durable Object with its own SQLite — the point of the diagram. Sourced from the
// Cloudflare adapter (host.ts, route-resolver.ts, scope-do.ts, control-plane-do.ts).
// Colors reuse the --layer-* accents purely to keep the three DBs visually distinct.

const steps = [
  {
    n: 1, kind: 'edge',
    title: 'Browser hits a hostname',
    body: 'A tenant, a vertical, and a surface — all encoded in the name.',
    mono: 'acme.callout.substrat.run',
  },
  {
    n: 2, kind: 'router',
    title: 'The router resolves the door',
    body: 'One kernel-owned worker in front of every vertical. Its only binding is the control plane — it reads the directory to turn hostname → (tenant, scope, vertical, surface). It finds the door; it cannot open a scope even by mistake.',
    touches: 'cp',
  },
  {
    n: 3, kind: 'compute',
    title: 'Header handshake, then dispatch',
    body: 'Every client x-substrat-* header is stripped; the router asserts the resolved node plus a shared secret, then dispatches to the vertical worker. The vertical has no public route — the router is the only way in.',
  },
  {
    n: 4, kind: 'compute',
    title: 'Vertical worker resolves who you are',
    body: 'The vertical worker holds no state between requests. It resolves your session to a principal in the tenant’s own identity database.',
    touches: 'id',
  },
  {
    n: 5, kind: 'compute',
    title: 'Open the scope, run the operation',
    body: 'Gate the scope’s lifecycle & tenancy, then invoke() runs the operation inside the scope’s own SQLite, in one transaction — permission check first, mutation emits an event, the outbox drains to consumers and connectors. Roll back on any throw.',
    touches: 'sc',
  },
  {
    n: 6, kind: 'edge',
    title: 'Response travels back up',
    body: 'Back through the router, the one place that knows the tenant — so it meters the request there, one datapoint per call.',
  },
];

const dbs = [
  {
    key: 'cp', card: 'Directory', name: 'Control-plane DB', count: 'one per environment',
    items: ['Tenant registry & scope lifecycle', 'Roles, tenant grants, entitlements', 'Hostnames, verticals & versions', 'Connections (ciphertext only)', 'The admin audit log'],
    tag: 'Knows which door — never what’s behind it. A single singleton DO.',
  },
  {
    key: 'id', card: 'Application / auth', name: 'Identity DB', count: 'one per tenant',
    items: ['Users, sessions, credentials', 'Its own auth engine, own SQLite', 'The login → principal map', 'The owner seat, set at provision'],
    tag: 'Separate DO, separate storage — one tenant’s users can’t leak to another.',
  },
  {
    key: 'sc', card: 'Business data', name: 'Scope DB', count: 'one per scope',
    items: ['The vertical’s entities & kernel spine', 'Events, outbox, entity links', 'Applied migrations', 'Scope-level grants & permissions'],
    tag: 'Where ctx.sql runs — one transaction per operation.',
  },
];

const touchLabel: Record<string, string> = {
  cp: 'reads → Control-plane DB',
  id: 'reads → Identity DB (this tenant)',
  sc: 'reads + writes → Scope DB (this scope)',
};

const prov = [
  ['Write the directory row.', 'The coordinator records the new scope in the control plane — the door now exists, gated by the tenant.'],
  ['Address the Scope DO.', 'The moment it’s named, its SQLite is born. A lazy migration builds the kernel spine and runs the vertical’s own module migrations in order — a PITR bookmark taken before each pass.'],
  ['Project permissions in.', 'The tenant’s current roles and grants are copied into the fresh scope so it can decide access from its own storage — then the migration frontier is recorded back to the directory.'],
  ['Identity DB, likewise.', 'The tenant’s Identity DO is created on first address — tables on construction, the owner seat set at provision, waiting to be claimed by the first login.'],
];

const kindLabel: Record<string, string> = {
  edge: 'edge', router: 'kernel worker · 1 per env', compute: 'compute',
};
</script>

<template>
  <div class="topo">
    <!-- Request flow -->
    <p class="subhead">How a request travels</p>
    <div class="flow">
      <div v-for="s in steps" :key="s.n" class="step" :class="{ last: s.n === steps.length }">
        <div class="gutter">
          <span class="badge">{{ s.n }}</span>
          <span class="spine"></span>
        </div>
        <div class="body">
          <p class="stitle">
            {{ s.title }}
            <span class="kind" :class="'kind--' + s.kind">{{ kindLabel[s.kind] }}</span>
          </p>
          <p class="sbody">{{ s.body }}</p>
          <code v-if="s.mono" class="mono">{{ s.mono }}</code>
          <span v-if="s.touches" class="touch">
            <span class="dot" :class="'dot--' + s.touches"></span>{{ touchLabel[s.touches] }}
          </span>
        </div>
      </div>
    </div>

    <!-- Three databases -->
    <p class="subhead">The three databases</p>
    <div class="dbs">
      <div v-for="d in dbs" :key="d.key" class="db" :class="'db--' + d.key">
        <svg class="cyl" viewBox="0 0 30 34" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <ellipse cx="15" cy="6" rx="12" ry="4.5" />
          <path d="M3 6v22c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5V6" />
          <path d="M3 17c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5" opacity=".55" />
        </svg>
        <p class="dbcard">{{ d.card }}</p>
        <p class="dbname">{{ d.name }}</p>
        <span class="count">{{ d.count }}</span>
        <ul>
          <li v-for="it in d.items" :key="it">{{ it }}</li>
        </ul>
        <p class="dbtag">{{ d.tag }}</p>
      </div>
    </div>

    <!-- Provisioning -->
    <p class="subhead">How the databases get created</p>
    <div class="prov">
      <p class="key">The trick: <b>a Durable Object’s database springs into existence the first time you address it by id.</b> There is no <code>CREATE DATABASE</code> and no migration server — provisioning is just addressing a new DO and letting it build itself.</p>
      <div class="psteps">
        <div v-for="([head, body], i) in prov" :key="i" class="pstep">
          <span class="pn">{{ i + 1 }}</span>
          <p><b>{{ head }}</b> {{ body }}</p>
        </div>
      </div>
    </div>

    <!-- Isolation callout -->
    <div class="iso">
      <p class="isohead">Why the shared control plane isn’t a shared blast radius</p>
      <p>A normal vertical runs <b>“CP-less” on the hot path</b>: it decides permissions from the scope’s <em>own</em> storage and trusts the node the router asserted — the shared control plane is <b>off the request path entirely</b>. It still owns provisioning and the audit spine, but a request serving one tenant never touches another tenant’s data, or the shared directory, to answer.</p>
      <p>The result: the same kernel guarantees, a per-tenant database, and a shared control plane whose failure can’t read or corrupt a running scope. <b>Isolation is the default, not a configuration you can forget.</b></p>
    </div>
  </div>
</template>

<style scoped>
.topo { margin: 24px 0 8px; font-family: var(--font-sans); }

.subhead {
  font-size: var(--text-lg);
  line-height: var(--lh-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--text-primary);
  margin: 34px 0 16px;
  display: flex; align-items: center; gap: 10px;
}
.subhead::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--layer-kernel); flex: none; }

/* Request flow */
.flow { display: flex; flex-direction: column; }
.step { display: grid; grid-template-columns: 32px 1fr; gap: 14px; }
.gutter { display: flex; flex-direction: column; align-items: center; }
.badge {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--layer-kernel); color: #fff;
  font-weight: var(--weight-bold); font-size: var(--text-sm);
  display: grid; place-items: center; flex: none;
  font-variant-numeric: tabular-nums;
}
.spine { width: 2px; flex: 1; background: var(--border-strong); margin: 4px 0; }
.step.last .spine { display: none; }
.body { padding-bottom: 20px; min-width: 0; }
.stitle {
  font-size: var(--text-md); line-height: var(--lh-md);
  font-weight: var(--weight-semibold); color: var(--text-primary);
  margin: 3px 0 4px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
}
.kind {
  font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase;
  font-weight: var(--weight-bold); padding: 2px 8px; border-radius: 999px; white-space: nowrap;
}
.kind--router, .kind--compute { color: var(--layer-engine); background: var(--cyan-50); border: 1px solid var(--cyan-100); }
.kind--edge { color: var(--layer-vertical); background: var(--amber-50); border: 1px solid var(--amber-100); }
.sbody { font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-secondary); margin: 0; }
.mono {
  display: inline-block; margin-top: 8px;
  font-family: var(--font-mono); font-size: var(--text-sm);
  background: var(--surface-inset); border: 1px solid var(--border-subtle);
  color: var(--text-primary); padding: 3px 9px; border-radius: 6px;
}
.touch {
  margin-top: 9px; display: inline-flex; align-items: center; gap: 8px;
  font-size: var(--text-sm); color: var(--text-primary);
  background: var(--surface-card); border: 1px solid var(--border-default);
  padding: 5px 11px 5px 9px; border-radius: 8px;
}
.dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.dot--cp { background: var(--layer-kernel); }
.dot--id { background: var(--layer-engine); }
.dot--sc { background: var(--layer-vertical); }

/* Databases */
.dbs { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.db {
  border: 1px solid var(--border-default);
  border-top: 3px solid var(--dbc, var(--border-strong));
  border-radius: 12px; padding: 16px 16px 14px;
  background: var(--surface-card);
  display: flex; flex-direction: column;
}
.db--cp { --dbc: var(--layer-kernel); }
.db--id { --dbc: var(--layer-engine); }
.db--sc { --dbc: var(--layer-vertical); }
.cyl { width: 26px; height: 30px; color: var(--dbc); margin-bottom: 8px; }
.dbcard { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; font-weight: var(--weight-bold); color: var(--text-tertiary); margin: 0 0 3px; }
.dbname { font-size: var(--text-md); line-height: var(--lh-md); font-weight: var(--weight-semibold); color: var(--text-primary); margin: 0 0 8px; }
.count {
  font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--dbc);
  background: color-mix(in srgb, var(--dbc) 12%, transparent);
  border-radius: 6px; padding: 3px 9px; align-self: flex-start; margin: 0 0 12px;
}
.db ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.db li { font-size: var(--text-sm); line-height: var(--lh-sm); color: var(--text-secondary); padding-left: 13px; position: relative; }
.db li::before { content: ""; position: absolute; left: 0; top: .5em; width: 5px; height: 5px; border-radius: 50%; background: var(--dbc); opacity: .6; }
.dbtag { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--border-subtle); font-size: var(--text-xs); line-height: var(--lh-xs); color: var(--text-tertiary); font-style: italic; }

/* Provisioning */
.prov { background: var(--surface-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 18px 20px; }
.key { font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-primary); margin: 0 0 16px; padding-left: 14px; border-left: 3px solid var(--layer-vertical); }
.key b { color: var(--layer-vertical); }
.key code { font-family: var(--font-mono); font-size: var(--text-sm); }
.psteps { display: flex; flex-direction: column; gap: 13px; }
.pstep { display: grid; grid-template-columns: 20px 1fr; gap: 12px; align-items: start; }
.pn { font-weight: var(--weight-bold); color: var(--layer-kernel); font-size: var(--text-md); font-variant-numeric: tabular-nums; }
.pstep p { margin: 0; font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-secondary); }
.pstep b { color: var(--text-primary); font-weight: var(--weight-semibold); }

/* Isolation */
.iso { margin-top: 18px; border: 1px dashed var(--layer-engine); border-radius: 12px; padding: 16px 18px; background: var(--cyan-50); }
.isohead { margin: 0 0 6px; font-size: var(--text-base); font-weight: var(--weight-bold); color: var(--layer-engine); }
.iso p:not(.isohead) { margin: 0; font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-primary); }
.iso p + p:not(.isohead) { margin-top: 9px; }
.iso b { font-weight: var(--weight-semibold); }

:global(html.dark) .kind--router,
:global(html.dark) .kind--compute { background: var(--status-info-bg); border-color: transparent; }
:global(html.dark) .kind--edge { background: var(--status-warning-bg); border-color: transparent; }
:global(html.dark) .iso { background: var(--status-info-bg); }
</style>
