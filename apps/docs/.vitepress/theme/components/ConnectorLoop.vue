<script setup lang="ts">
// The connector round trip: a delivery leaves the Scope DO, crosses the platform
// boundary, and returns through a different door. The dashed box is the only one
// outside the platform, and the only leg drawn twice is the one that leaves and
// comes back — which is the whole point of the picture.
//
// Every string it renders lives in ./ConnectorLoop.content.mts, because llms.mts
// flattens that module into the page's markdown twin. A fact typed into this
// template renders here and vanishes from llms.txt. Put it in the content module.
import { aria, arrows, caption, provider, runtime, scope } from './ConnectorLoop.content.mjs';
</script>

<template>
  <figure class="fig">
    <svg viewBox="0 0 700 380" role="img" :aria-label="aria">
      <defs>
        <marker id="cl-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <rect class="fbox" x="40" y="36" width="300" height="120" rx="10" />
      <text class="t-tag" x="58" y="58">{{ scope.tag }}</text>
      <text class="t-title" x="58" y="80">{{ scope.title }}</text>
      <text v-for="(l, i) in scope.sub" :key="l" class="t-sub" x="58" :y="100 + i * 17">{{ l }}</text>
      <rect class="fchip fchip--v" x="58" y="126" width="264" height="26" rx="6" />
      <circle class="ldot ldot--v" cx="74" cy="139" r="4" />
      <text class="t-sub" x="88" y="143">{{ scope.chip }}</text>

      <path class="flowline" d="M130 162 V226" marker-end="url(#cl-arw)" />
      <text class="t-arw" x="142" y="190">{{ arrows.out }}</text>

      <path class="flowline" d="M280 226 V162" marker-end="url(#cl-arw)" />
      <text class="t-arw" x="268" y="214" text-anchor="end">{{ arrows.back }}</text>

      <rect class="fbox" x="40" y="236" width="300" height="120" rx="10" />
      <text class="t-tag" x="58" y="258">{{ runtime.tag }}</text>
      <text class="t-title" x="58" y="280">{{ runtime.title }}</text>
      <text v-for="(l, i) in runtime.sub" :key="l" class="t-sub" x="58" :y="300 + i * 17">{{ l }}</text>
      <rect class="fchip fchip--k" x="58" y="326" width="264" height="26" rx="6" />
      <circle class="ldot ldot--k" cx="74" cy="339" r="4" />
      <text class="t-sub" x="88" y="343">{{ runtime.chip }}</text>

      <path class="flowline" d="M346 268 L396 200" marker-end="url(#cl-arw)" />
      <text class="t-arw" x="530" y="124" text-anchor="middle">{{ arrows.send }}</text>

      <path class="flowline" d="M396 232 L346 310" marker-end="url(#cl-arw)" />
      <text class="t-arw" x="530" y="280" text-anchor="middle">{{ arrows.callback }}</text>

      <rect class="fbox outside" x="400" y="136" width="260" height="120" rx="10" />
      <text class="t-tag" x="418" y="158">{{ provider.tag }}</text>
      <text class="t-title" x="418" y="180">{{ provider.title }}</text>
      <text class="t-sub" x="418" y="200">{{ provider.sub }}</text>
      <rect class="fpane" x="418" y="210" width="200" height="26" rx="6" />
      <text class="t-sub" x="432" y="227">{{ provider.chip }}</text>
    </svg>
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
/* Fills come from semantic surface tokens, never the raw --brand-50 / --cyan-50
   scales: those are not redefined in dark mode, so a chip painted with one stays
   near-white on a dark ground. The layer accent rides on the dot and the border. */
.fig { margin: 24px 0 26px; overflow-x: auto; font-family: var(--font-sans); }
.fig svg { display: block; width: 100%; max-width: 700px; height: auto; }
.fig figcaption {
  font-size: var(--text-sm); line-height: var(--lh-sm);
  color: var(--text-tertiary); margin-top: 12px; max-width: 62ch;
}

.fbox { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1.4; }
.fbox.outside { fill: var(--surface-inset); stroke-dasharray: 6 4; }
.fpane { fill: var(--surface-inset); stroke: var(--border-subtle); stroke-width: 1; }
.fchip { fill: var(--surface-inset); stroke: var(--border-default); stroke-width: 1; }
.fchip--k { stroke: var(--layer-kernel); stroke-opacity: .45; }
.fchip--v { stroke: var(--layer-vertical); stroke-opacity: .45; }

.ldot--k { fill: var(--layer-kernel); }
.ldot--v { fill: var(--layer-vertical); }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.8; }
.mk { fill: var(--border-strong); }

.t-title { fill: var(--text-primary);   font: var(--weight-semibold) 14px var(--font-sans); }
.t-sub   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-arw   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-tag {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}
</style>
