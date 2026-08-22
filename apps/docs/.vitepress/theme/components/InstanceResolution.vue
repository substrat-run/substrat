<script setup lang="ts">
// The lookup a hostname performs, with the one mutable link drawn as the one
// mutable link. Everything else on the page is a consequence of this shape.
//
// Every string it renders lives in ./InstanceResolution.content.mts, because
// llms.mts flattens that module into the page's markdown twin.
import { aria, binding, caption, chain, edges, environments } from './InstanceResolution.content.mjs';
</script>

<template>
  <figure class="fig">
    <svg viewBox="0 0 700 470" role="img" :aria-label="aria">
      <defs>
        <marker id="ir-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <g v-for="(c, i) in chain" :key="c.title">
        <rect class="ibox" :class="{ 'ibox--immutable': c.tag === 'immutable' }" x="30" :y="30 + i * 118" width="380" height="82" rx="10" />
        <text class="t-tag" x="48" :y="52 + i * 118">{{ c.tag }}</text>
        <text class="t-title" x="48" :y="74 + i * 118">{{ c.title }}</text>
        <text class="t-sub" x="48" :y="94 + i * 118">{{ c.sub }}</text>
        <text class="t-git" x="392" :y="52 + i * 118" text-anchor="end">{{ c.git }}</text>
      </g>

      <path class="flowline" d="M100 112 V144" marker-end="url(#ir-arw)" />
      <text class="t-edge" x="112" y="132">{{ edges[0] }}</text>

      <!-- the one mutable link -->
      <path class="flowline moves" d="M100 230 V262" marker-end="url(#ir-arw)" />
      <text class="t-edge t-edge--moves" x="112" y="250">{{ edges[1] }}</text>
      <rect class="mbox" x="230" y="212" width="290" height="52" rx="9" />
      <text class="t-mtitle" x="248" y="234">{{ binding.title }} — {{ binding.git }}</text>
      <text class="t-sub" x="248" y="252">{{ binding.detail }}</text>

      <text class="t-tag" x="30" y="386">what moves the binding</text>
      <g v-for="(e, i) in environments" :key="e[0]">
        <text class="t-env" x="30" :y="410 + i * 20">{{ e[0] }}</text>
        <text class="t-sub" x="106" :y="410 + i * 20">{{ e[1] }}</text>
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

.ibox { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1.4; }
.ibox--immutable { stroke: var(--layer-kernel); stroke-opacity: .55; }
/* The mutable link is the only thing an environment is, so it is the only thing
   drawn in the accent — everything else on this page is a consequence of it. */
.mbox { fill: var(--surface-inset); stroke: var(--layer-vertical); stroke-width: 1.6; }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.8; }
.flowline.moves { stroke: var(--layer-vertical); stroke-width: 2.2; }
.mk { fill: var(--border-strong); }

.t-title  { fill: var(--text-primary);   font: var(--weight-semibold) 14px var(--font-sans); }
.t-mtitle { fill: var(--text-primary);   font: var(--weight-semibold) 12.5px var(--font-sans); }
.t-sub    { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-edge   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-edge--moves { fill: var(--layer-vertical); font-weight: var(--weight-medium); }
.t-env    { fill: var(--text-primary);   font: var(--weight-medium) 11.5px var(--font-mono); }
.t-git    { fill: var(--text-tertiary);  font: var(--weight-regular) 11px var(--font-sans); font-style: italic; }
.t-tag {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}
</style>
