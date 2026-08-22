<script setup lang="ts">
// A tenant containing its scopes, with the database boundary drawn where it
// actually falls. The containing box is the billing and identity boundary; each
// inner box is a separate database, which is why they are drawn apart rather
// than as cells of one table.
//
// Every string it renders lives in ./TenancyTree.content.mts, because llms.mts
// flattens that module into the page's markdown twin.
import { aria, barrier, caption, deeper, scopeFacts, scopes, tenant } from './TenancyTree.content.mjs';
</script>

<template>
  <figure class="fig">
    <svg viewBox="0 0 700 430" role="img" :aria-label="aria">
      <defs>
        <marker id="tt-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <rect class="tbox" x="24" y="24" width="652" height="252" rx="14" />
      <text class="t-tag" x="46" y="50">{{ tenant.tag }}</text>
      <text class="t-title" x="46" y="72">{{ tenant.title }}</text>
      <text class="t-sub" x="46" y="92">{{ tenant.sub }}</text>
      <text class="t-note" x="46" y="110">{{ tenant.note }}</text>

      <path class="flowline" d="M64 118 V136 H558" />

      <g v-for="(s, i) in scopes" :key="s.slug">
        <path class="flowline" :d="`M${142 + i * 208} 136 V152`" marker-end="url(#tt-arw)" />
        <rect class="sbox" :x="46 + i * 208" y="158" width="192" height="94" rx="10" />
        <svg :x="56 + i * 208" y="170" width="20" height="24" viewBox="0 0 30 34" fill="none" stroke="currentColor" stroke-width="1.8" class="cyl" aria-hidden="true">
          <ellipse cx="15" cy="6" rx="12" ry="4.5" />
          <path d="M3 6v22c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5V6" />
          <path d="M3 17c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5" opacity=".55" />
        </svg>
        <text class="t-slug" :x="84 + i * 208" y="186">{{ s.slug }}</text>
        <text class="t-sub" :x="62 + i * 208" y="216">kind: {{ s.kind }}</text>
        <text class="t-note" :x="62 + i * 208" y="234">{{ s.note }}</text>
      </g>

      <path class="barrier" d="M246 150 V262" />
      <path class="barrier" d="M454 150 V262" />
      <text class="t-barrier" x="350" y="296" text-anchor="middle">{{ barrier }}</text>

      <text class="t-tag" x="24" y="330">every scope is</text>
      <text v-for="(f, i) in scopeFacts" :key="f" class="t-sub" x="24" :y="350 + i * 17">· {{ f }}</text>
    </svg>
    <figcaption>{{ deeper }} {{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.fig { margin: 24px 0 26px; overflow-x: auto; font-family: var(--font-sans); }
.fig svg { display: block; width: 100%; max-width: 700px; height: auto; }
.fig figcaption {
  font-size: var(--text-sm); line-height: var(--lh-sm);
  color: var(--text-tertiary); margin-top: 12px; max-width: 62ch;
}

/* The tenant is a boundary, not a container of rows — hence a wash, not a card. */
.tbox { fill: var(--surface-inset); stroke: var(--layer-kernel); stroke-opacity: .4; stroke-width: 1.4; }
.sbox { fill: var(--surface-card); stroke: var(--layer-engine); stroke-opacity: .6; stroke-width: 1.4; }
.cyl  { color: var(--layer-engine); }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.5; }
.mk { fill: var(--border-strong); }
.barrier { stroke: var(--layer-vertical); stroke-width: 1.6; stroke-dasharray: 7 5; fill: none; }

.t-title { fill: var(--text-primary);   font: var(--weight-semibold) 15px var(--font-sans); }
.t-slug  { fill: var(--text-primary);   font: var(--weight-medium) 13px var(--font-mono); }
.t-sub   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-note  { fill: var(--text-tertiary);  font: var(--weight-regular) 11px var(--font-sans); }
.t-barrier { fill: var(--layer-vertical); font: var(--weight-medium) 11.5px var(--font-sans); }
.t-tag {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}
</style>
