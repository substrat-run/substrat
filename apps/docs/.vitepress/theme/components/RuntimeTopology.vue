<script setup lang="ts">
// The runtime topology: how a request travels from a hostname through the router
// to a scope, and the three per-tenant/per-scope databases behind it. Every box is
// a Durable Object with its own SQLite — the point of the diagram. Sourced from the
// Cloudflare adapter (host.ts, route-resolver.ts, scope-do.ts, control-plane-do.ts).
// Colors reuse the --layer-* accents purely to keep the three DBs visually distinct.
//
// Every string it renders lives in ./RuntimeTopology.content.mts, because llms.mts
// flattens that module into the page's markdown twin. A fact typed into this
// template renders here and vanishes from llms.txt. Put it in the data module.
import {
  dbs, diagram, headings, isolation, kindLabel, prov, provKey, residency, steps, touchLabel,
} from './RuntimeTopology.content.mjs';
</script>

<template>
  <div class="topo">
    <!-- Request flow -->
    <p class="subhead">{{ headings.flow }}</p>

    <!-- The round trip. The numbered steps below carry the detail; this carries
         the one thing they cannot — that the request comes back. -->
    <figure class="fig">
      <svg viewBox="0 0 700 812" role="img" :aria-label="diagram.aria">
        <defs>
          <marker id="rt-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
            <polygon class="mk" points="0 0, 9 3.5, 0 7" />
          </marker>
        </defs>

        <path class="flowline back" d="M40 520 H16 V64 H30" marker-end="url(#rt-arw)" />
        <text class="t-rot" x="32" y="300" text-anchor="middle" transform="rotate(-90 32 300)">{{ diagram.ret }}</text>

        <rect class="fbox" x="40" y="36" width="250" height="56" rx="10" />
        <text class="t-title" x="58" y="62">{{ diagram.browser.title }}</text>
        <text class="t-mono" x="58" y="81">{{ diagram.browser.mono }}</text>

        <path class="flowline" d="M165 98 V142" marker-end="url(#rt-arw)" />
        <text class="t-arw" x="177" y="124">{{ diagram.toRouter }}</text>

        <rect class="fbox" x="40" y="148" width="250" height="128" rx="10" />
        <text class="t-tag" x="58" y="170">{{ diagram.router.tag }}</text>
        <text class="t-title" x="58" y="192">{{ diagram.router.title }}</text>
        <text v-for="(l, i) in diagram.router.sub" :key="l" class="t-sub" x="58" :y="212 + i * 17">{{ l }}</text>
        <rect class="fchip fchip--k" x="58" y="240" width="98" height="22" rx="6" />
        <circle class="ldot ldot--k" cx="70" cy="251" r="3.5" />
        <text class="t-chip t-chip--k" x="80" y="255">{{ diagram.router.chip }}</text>

        <path class="flowline" d="M296 212 H400" marker-end="url(#rt-arw)" />
        <text class="t-arw" x="348" y="200" text-anchor="middle">{{ diagram.toControlPlane }}</text>

        <rect class="fbox" x="410" y="148" width="250" height="128" rx="10" />
        <text class="t-tag" x="428" y="170">{{ diagram.controlPlane.tag }}</text>
        <text class="t-title" x="428" y="192">{{ diagram.controlPlane.title }}</text>
        <text v-for="(l, i) in diagram.controlPlane.sub" :key="l" class="t-sub" x="428" :y="212 + i * 17">{{ l }}</text>
        <rect class="fchip fchip--k" x="428" y="240" width="98" height="22" rx="6" />
        <circle class="ldot ldot--k" cx="440" cy="251" r="3.5" />
        <text class="t-chip t-chip--k" x="450" y="255">{{ diagram.controlPlane.chip }}</text>

        <path class="flowline" d="M165 282 V326" marker-end="url(#rt-arw)" />
        <text class="t-arw" x="177" y="308">{{ diagram.toWorker }}</text>

        <rect class="fbox" x="40" y="332" width="620" height="220" rx="10" />
        <text class="t-tag" x="58" y="354">{{ diagram.worker.tag }}</text>
        <text class="t-title" x="58" y="376">{{ diagram.worker.title }}</text>
        <text class="t-sub" x="58" y="396">{{ diagram.worker.sub }}</text>

        <g v-for="(pane, i) in residency.worker" :key="pane.title">
          <rect class="fpane" x="58" :y="406 + i * 44" width="584" height="40" rx="8" />
          <circle class="ldot" :class="'ldot--' + pane.dot" cx="74" :cy="420 + i * 44" r="4.5" />
          <text class="t-mid" x="88" :y="424 + i * 44">{{ pane.title }}</text>
          <text class="t-sub" x="88" :y="440 + i * 44">{{ pane.detail }}</text>
        </g>

        <path class="flowline" d="M160 558 V600" marker-end="url(#rt-arw)" />
        <text class="t-arw" x="172" y="580">{{ diagram.toIdentity }}</text>

        <path class="flowline" d="M485 558 V600" marker-end="url(#rt-arw)" />
        <text class="t-arw" x="473" y="580" text-anchor="end">{{ diagram.toScope }}</text>

        <rect class="fbox" x="40" y="606" width="240" height="128" rx="10" />
        <text class="t-tag" x="58" y="628">{{ diagram.identity.tag }}</text>
        <text class="t-title" x="58" y="650">{{ diagram.identity.title }}</text>
        <text v-for="(l, i) in diagram.identity.sub" :key="l" class="t-sub" x="58" :y="670 + i * 17">{{ l }}</text>
        <rect class="fchip fchip--k" x="58" y="698" width="98" height="22" rx="6" />
        <circle class="ldot ldot--k" cx="70" cy="709" r="3.5" />
        <text class="t-chip t-chip--k" x="80" y="713">{{ diagram.identity.chip }}</text>

        <rect class="fbox" x="310" y="606" width="350" height="176" rx="10" />
        <text class="t-tag" x="328" y="628">{{ diagram.scope.tag }}</text>
        <text class="t-title" x="328" y="650">{{ diagram.scope.title }}</text>
        <text class="t-sub" x="328" y="670">{{ diagram.scope.sub }}</text>

        <g v-for="(row, i) in residency.scope" :key="row.text">
          <rect class="fchip" :class="'fchip--' + row.dot" x="328" :y="680 + i * 28" width="314" height="24" rx="6" />
          <circle class="ldot" :class="'ldot--' + row.dot" cx="344" :cy="692 + i * 28" r="4" />
          <text class="t-sub" x="358" :y="696 + i * 28">{{ row.text }}</text>
        </g>
      </svg>
      <figcaption>{{ residency.intro }}</figcaption>
    </figure>

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
    <p class="subhead">{{ headings.dbs }}</p>
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
    <p class="subhead">{{ headings.provisioning }}</p>
    <div class="prov">
      <p class="key" v-html="provKey"></p>
      <div class="psteps">
        <div v-for="([head, body], i) in prov" :key="i" class="pstep">
          <span class="pn">{{ i + 1 }}</span>
          <p><b>{{ head }}</b> {{ body }}</p>
        </div>
      </div>
    </div>

    <!-- Isolation callout -->
    <div class="iso">
      <p class="isohead">{{ isolation.head }}</p>
      <p v-for="(para, i) in isolation.paragraphs" :key="i" v-html="para"></p>
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

/* The round-trip figure. Every fill comes from a semantic surface token rather
   than a raw scale value: the raw --brand-50 / --cyan-50 scales are not
   redefined in dark mode, so a chip painted with one stays near-white on a dark
   ground. The layer accent rides on the dot and the border instead. */
.fig { margin: 0 0 26px; overflow-x: auto; }
.fig svg { display: block; width: 100%; max-width: 700px; height: auto; }
.fig figcaption {
  font-size: var(--text-sm); line-height: var(--lh-sm);
  color: var(--text-tertiary); margin-top: 12px; max-width: 62ch;
}

.fbox  { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1.4; }
.fpane { fill: var(--surface-inset); stroke: var(--border-subtle); stroke-width: 1; }
.fchip { fill: var(--surface-inset); stroke: var(--border-default); stroke-width: 1; }
.fchip--k { stroke: var(--layer-kernel); stroke-opacity: .45; }
.fchip--e { stroke: var(--layer-engine); stroke-opacity: .45; }
.fchip--v { stroke: var(--layer-vertical); stroke-opacity: .45; }

.ldot--k { fill: var(--layer-kernel); }
.ldot--e { fill: var(--layer-engine); }
.ldot--v { fill: var(--layer-vertical); }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.8; }
.flowline.back { stroke-width: 1.4; stroke-dasharray: 5 4; }
.mk { fill: var(--border-strong); }

.t-title { fill: var(--text-primary);   font: var(--weight-semibold) 14px var(--font-sans); }
.t-mid   { fill: var(--text-primary);   font: var(--weight-semibold) 12.5px var(--font-sans); }
.t-sub   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-arw   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-mono  { fill: var(--text-primary);   font: var(--weight-regular) 11.5px var(--font-mono); }
.t-chip  { font: var(--weight-medium) 10.5px var(--font-sans); }
.t-chip--k { fill: var(--layer-kernel); }
.t-tag {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}
.t-rot {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}

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
