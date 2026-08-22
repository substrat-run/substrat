<script setup lang="ts">
// The adapter-neutral topology: vertical code, the scope host, N isolated
// scopes, one event spine. Drawn by hand rather than by mermaid so the fan-out
// is the shape you see first — that is the claim the picture exists to make.
//
// Every string it renders lives in ./ScopeTopology.content.mts, because llms.mts
// flattens that module into the page's markdown twin. A fact typed into this
// template renders here and vanishes from llms.txt. Put it in the content module.
import {
  aria, caption, host, scopes, spine, toHost, toScopes, toSpine, vertical,
} from './ScopeTopology.content.mjs';
</script>

<template>
  <figure class="fig">
    <svg viewBox="0 0 700 626" role="img" :aria-label="aria">
      <defs>
        <marker id="st-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <rect class="fbox fbox--v" x="180" y="30" width="340" height="86" rx="10" />
      <text class="t-tag" x="198" y="52">{{ vertical.tag }}</text>
      <text class="t-title" x="198" y="74">{{ vertical.title }}</text>
      <text class="t-sub" x="198" y="94">{{ vertical.sub }}</text>

      <path class="flowline" d="M350 122 V162" marker-end="url(#st-arw)" />
      <text class="t-arw" x="362" y="148">{{ toHost }}</text>

      <rect class="fbox fbox--k" x="140" y="172" width="420" height="94" rx="10" />
      <text class="t-tag" x="158" y="194">{{ host.tag }}</text>
      <text class="t-title" x="158" y="216">{{ host.title }}</text>
      <text class="t-mono" x="158" y="240">{{ host.mono }}</text>

      <path class="flowline" d="M250 272 L168 310" marker-end="url(#st-arw)" />
      <path class="flowline" d="M450 272 L532 310" marker-end="url(#st-arw)" />
      <text class="t-arw" x="350" y="298" text-anchor="middle">{{ toScopes }}</text>

      <g v-for="(s, i) in scopes" :key="s.title">
        <rect class="fbox fbox--k" :x="40 + i * 340" y="320" width="280" height="130" rx="10" />
        <text class="t-tag" :x="58 + i * 340" y="342">{{ s.tag }}</text>
        <text class="t-title" :x="58 + i * 340" y="364">{{ s.title }}</text>
        <text v-for="(l, j) in s.sub" :key="l" class="t-sub" :x="58 + i * 340" :y="384 + j * 17">{{ l }}</text>
      </g>

      <path class="flowline" d="M180 456 L246 510" marker-end="url(#st-arw)" />
      <path class="flowline" d="M520 456 L454 510" marker-end="url(#st-arw)" />
      <text class="t-arw" x="350" y="492" text-anchor="middle">{{ toSpine }}</text>

      <rect class="fbox fbox--k" x="140" y="520" width="420" height="86" rx="10" />
      <text class="t-tag" x="158" y="542">{{ spine.tag }}</text>
      <text class="t-title" x="158" y="564">{{ spine.title }}</text>
      <text class="t-sub" x="158" y="584">{{ spine.sub }}</text>
    </svg>
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
/* Fills come from semantic surface tokens, never the raw --brand-50 / --cyan-50
   scales: those are not redefined in dark mode, so a box painted with one stays
   near-white on a dark ground. The layer accent rides on the border. */
.fig { margin: 24px 0 26px; overflow-x: auto; font-family: var(--font-sans); }
.fig svg { display: block; width: 100%; max-width: 700px; height: auto; }
.fig figcaption {
  font-size: var(--text-sm); line-height: var(--lh-sm);
  color: var(--text-tertiary); margin-top: 12px; max-width: 62ch;
}

.fbox { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1.4; }
.fbox--k { stroke: var(--layer-kernel); stroke-opacity: .5; }
.fbox--v { stroke: var(--layer-vertical); stroke-opacity: .5; }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.8; }
.mk { fill: var(--border-strong); }

.t-title { fill: var(--text-primary);   font: var(--weight-semibold) 14px var(--font-sans); }
.t-sub   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-arw   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-mono  { fill: var(--text-primary);   font: var(--weight-regular) 12px var(--font-mono); }
.t-tag {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}
</style>
