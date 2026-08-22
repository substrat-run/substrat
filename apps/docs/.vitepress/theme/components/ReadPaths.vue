<script setup lang="ts">
// The three read paths as distance from one boundary, because distance from the
// scope that owns the data IS the staleness. Three peer boxes would just restate
// the table above.
//
// Every string it renders lives in ./ReadPaths.content.mts, because llms.mts
// flattens that module into the page's markdown twin.
import { aria, boundary, caption, paths } from './ReadPaths.content.mjs';

</script>

<template>
  <figure class="fig">
    <svg viewBox="0 0 700 446" role="img" :aria-label="aria">
      <defs>
        <marker id="rp-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <!-- inside the scope: the default, and the only path with no second store -->
      <rect class="scope" x="24" y="24" width="652" height="172" rx="12" />
      <text class="t-scope" x="44" y="52">Scope</text>
      <text class="t-sub" x="44" y="72">its own database · one operation at a time</text>

      <rect class="pbox pbox--inside" x="44" y="92" width="612" height="84" rx="10" />
      <text class="t-n" x="60" y="118">{{ paths[0].n }}</text>
      <text class="t-ptitle" x="78" y="118">{{ paths[0].title }}</text>
      <text class="t-sub" x="60" y="138">{{ paths[0].how }}</text>
      <text class="t-meta" x="60" y="162">{{ paths[0].latency }} · {{ paths[0].consistency }}</text>
      <text class="t-use" x="640" y="162" text-anchor="end">{{ paths[0].use }}</text>

      <!-- the boundary distance is measured from -->
      <path class="barrier" d="M24 216 H676" />
      <text class="t-tag t-tag--scope" x="350" y="210" text-anchor="middle">{{ boundary }}</text>

      <g v-for="(p, i) in paths.slice(1)" :key="p.n">
        <path class="flowline" :d="`M100 ${i === 0 ? 216 : 332 + (i - 1) * 96} V${248 + i * 96 - 4}`" marker-end="url(#rp-arw)" />
        <rect class="pbox pbox--outside" x="44" :y="248 + i * 96" width="612" height="84" rx="10" />
        <text class="t-n" x="60" :y="274 + i * 96">{{ p.n }}</text>
        <text class="t-ptitle" x="78" :y="274 + i * 96">{{ p.title }}</text>
        <text class="t-sub" x="60" :y="294 + i * 96">{{ p.how }}</text>
        <text class="t-meta" x="60" :y="318 + i * 96">{{ p.latency }} · {{ p.consistency }}</text>
        <text class="t-use" x="640" :y="318 + i * 96" text-anchor="end">{{ p.use }}</text>
      </g>
    </svg>
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.fig { margin: 24px 0 26px; overflow-x: auto; font-family: var(--font-sans); }
.fig svg { display: block; width: 100%; max-width: 700px; height: auto; }
.fig figcaption {
  font-size: var(--text-sm); line-height: var(--lh-sm);
  color: var(--text-tertiary); margin-top: 12px; max-width: 62ch;
}

.scope { fill: var(--surface-inset); stroke: var(--layer-engine); stroke-opacity: .5; stroke-width: 1.5; }
.pbox { fill: var(--surface-card); stroke-width: 1.4; }
/* Inside the boundary is the default and reads as such; outside is dashed,
   because everything out there is allowed to be behind. */
.pbox--inside  { stroke: var(--layer-engine); stroke-opacity: .8; }
.pbox--outside { stroke: var(--border-strong); stroke-dasharray: 6 4; }
.barrier { stroke: var(--layer-vertical); stroke-width: 1.5; stroke-dasharray: 7 5; fill: none; }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.7; }
.mk { fill: var(--border-strong); }

.t-scope  { fill: var(--text-primary);   font: var(--weight-semibold) 16px var(--font-sans); }
.t-ptitle { fill: var(--text-primary);   font: var(--weight-semibold) 13px var(--font-sans); }
.t-n      { fill: var(--layer-engine);   font: var(--weight-bold) 13px var(--font-sans); }
.t-sub    { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-use    { fill: var(--text-tertiary);  font: var(--weight-regular) 11px var(--font-sans); font-style: italic; }
.t-meta   { fill: var(--text-primary);   font: var(--weight-medium) 11.5px var(--font-mono); }
.t-tag {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}
.t-tag--scope { fill: var(--layer-engine); }
</style>
