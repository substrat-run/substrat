<script setup lang="ts">
// How committed work leaves a scope. One transaction at the top; two paths into the
// control plane — the kick, which a response flag starts, and the sweep, which nothing
// starts because it runs on a clock. The sweep therefore has no arrow INTO it, on
// purpose: drawing one would say it waits for a signal, and its whole value is that it
// does not.
//
// Every string it renders lives in ./ScopeDrain.content.mts, because llms.mts flattens
// that module into the page's markdown twin. Put facts there, not here.
import {
  aria,
  caption,
  commit,
  events,
  fromKick,
  fromSweep,
  intents,
  kick,
  platform,
  sweep,
  toEvents,
  toIntents,
  toKick,
} from './ScopeDrain.content.mjs';

const H = 96;
// Two columns share one centre line each, so every arrow is a straight vertical —
// a diagonal here would read as a route, and none of these hops has a route.
const LEFT = { x: 30, w: 300, cx: 180 };
const RIGHT = { x: 370, w: 300, cx: 520 };
const ROW = { commit: 24, paths: 196, platform: 368, out: 540 };
</script>

<template>
  <figure class="fig">
    <svg viewBox="0 0 700 656" role="img" :aria-label="aria">
      <defs>
        <marker id="sd-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <!-- one transaction -->
      <rect class="pbox pbox--scope" x="30" :y="ROW.commit" width="640" :height="H" rx="10" />
      <text class="t-tag t-tag--scope" x="48" :y="ROW.commit + 22">{{ commit.tag }}</text>
      <text class="t-title" x="48" :y="ROW.commit + 44">{{ commit.title }}</text>
      <text v-for="(l, j) in commit.sub" :key="l" class="t-sub" x="48" :y="ROW.commit + 64 + j * 16">{{ l }}</text>

      <!-- the kick: started by the response -->
      <path class="flowline" :d="`M${LEFT.cx} ${ROW.commit + H} V${ROW.paths - 4}`" marker-end="url(#sd-arw)" />
      <text class="t-edge" :x="LEFT.cx + 12" :y="ROW.commit + H + 42">{{ toKick }}</text>

      <rect class="pbox" :x="LEFT.x" :y="ROW.paths" :width="LEFT.w" :height="H" rx="10" />
      <text class="t-tag" :x="LEFT.x + 18" :y="ROW.paths + 22">{{ kick.tag }}</text>
      <text class="t-title" :x="LEFT.x + 18" :y="ROW.paths + 44">{{ kick.title }}</text>
      <text v-for="(l, j) in kick.sub" :key="l" class="t-sub" :x="LEFT.x + 18" :y="ROW.paths + 64 + j * 16">{{ l }}</text>

      <!-- the sweep: nothing flows in, it runs on a clock -->
      <rect class="pbox pbox--backstop" :x="RIGHT.x" :y="ROW.paths" :width="RIGHT.w" :height="H" rx="10" />
      <text class="t-tag" :x="RIGHT.x + 18" :y="ROW.paths + 22">{{ sweep.tag }}</text>
      <text class="t-title" :x="RIGHT.x + 18" :y="ROW.paths + 44">{{ sweep.title }}</text>
      <text v-for="(l, j) in sweep.sub" :key="l" class="t-sub" :x="RIGHT.x + 18" :y="ROW.paths + 64 + j * 16">{{ l }}</text>

      <!-- both into the control plane -->
      <path class="flowline" :d="`M${LEFT.cx} ${ROW.paths + H} V${ROW.platform - 4}`" marker-end="url(#sd-arw)" />
      <text class="t-edge" :x="LEFT.cx + 12" :y="ROW.paths + H + 42">{{ fromKick }}</text>
      <path class="flowline dashed" :d="`M${RIGHT.cx} ${ROW.paths + H} V${ROW.platform - 4}`" marker-end="url(#sd-arw)" />
      <text class="t-edge" :x="RIGHT.cx - 12" :y="ROW.paths + H + 42" text-anchor="end">{{ fromSweep }}</text>

      <rect class="pbox pbox--platform" x="30" :y="ROW.platform" width="640" :height="H" rx="10" />
      <text class="t-tag t-tag--platform" x="48" :y="ROW.platform + 22">{{ platform.tag }}</text>
      <text class="t-title" x="48" :y="ROW.platform + 44">{{ platform.title }}</text>
      <text v-for="(l, j) in platform.sub" :key="l" class="t-sub" x="48" :y="ROW.platform + 64 + j * 16">{{ l }}</text>

      <!-- what it does with each -->
      <path class="flowline" :d="`M${LEFT.cx} ${ROW.platform + H} V${ROW.out - 4}`" marker-end="url(#sd-arw)" />
      <text class="t-edge" :x="LEFT.cx + 12" :y="ROW.platform + H + 42">{{ toIntents }}</text>
      <path class="flowline" :d="`M${RIGHT.cx} ${ROW.platform + H} V${ROW.out - 4}`" marker-end="url(#sd-arw)" />
      <text class="t-edge" :x="RIGHT.cx - 12" :y="ROW.platform + H + 42" text-anchor="end">{{ toEvents }}</text>

      <rect class="pbox" :x="LEFT.x" :y="ROW.out" :width="LEFT.w" :height="H" rx="10" />
      <text class="t-tag" :x="LEFT.x + 18" :y="ROW.out + 22">{{ intents.tag }}</text>
      <text class="t-title" :x="LEFT.x + 18" :y="ROW.out + 44">{{ intents.title }}</text>
      <text v-for="(l, j) in intents.sub" :key="l" class="t-sub" :x="LEFT.x + 18" :y="ROW.out + 64 + j * 16">{{ l }}</text>

      <rect class="pbox" :x="RIGHT.x" :y="ROW.out" :width="RIGHT.w" :height="H" rx="10" />
      <text class="t-tag" :x="RIGHT.x + 18" :y="ROW.out + 22">{{ events.tag }}</text>
      <text class="t-title" :x="RIGHT.x + 18" :y="ROW.out + 44">{{ events.title }}</text>
      <text v-for="(l, j) in events.sub" :key="l" class="t-sub" :x="RIGHT.x + 18" :y="ROW.out + 64 + j * 16">{{ l }}</text>
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

.pbox { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1.4; }
/* The transaction is the vertical's operation; the drain is the platform's. */
.pbox--scope { stroke: var(--layer-vertical); stroke-opacity: .6; }
.pbox--platform { stroke: var(--layer-kernel); stroke-opacity: .7; stroke-width: 1.8; }
/* The backstop is always running rather than started, so it is drawn as an aside. */
.pbox--backstop { fill: var(--surface-inset); stroke-dasharray: 6 4; }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.8; }
.flowline.dashed { stroke-dasharray: 5 4; stroke-width: 1.4; }
.mk { fill: var(--border-strong); }

.t-title { fill: var(--text-primary);   font: var(--weight-semibold) 14px var(--font-sans); }
.t-sub   { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-edge  { fill: var(--text-secondary); font: var(--weight-regular) 11.5px var(--font-sans); }
.t-tag {
  fill: var(--text-tertiary); font: var(--weight-medium) 10px var(--font-sans);
  letter-spacing: var(--tracking-caps); text-transform: uppercase;
}
.t-tag--scope { fill: var(--layer-vertical); }
.t-tag--platform { fill: var(--layer-kernel); }
</style>
