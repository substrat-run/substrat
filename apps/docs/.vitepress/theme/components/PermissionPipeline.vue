<script setup lang="ts">
// A permission's route from TypeScript to ctx.check. One spine, and one branch
// that leaves it for a human — drawn dashed and going nowhere else on purpose,
// because a review is not a stage the surface passes through.
//
// Every string it renders lives in ./PermissionPipeline.content.mts, because
// llms.mts flattens that module into the page's markdown twin.
import { aria, caption, review, source, stages, toReview } from './PermissionPipeline.content.mjs';

const BOX_W = 330;
const BOX_H = 88;
const PITCH = 128;
const X = 30;
const top = (i: number) => 30 + i * PITCH;
</script>

<template>
  <figure class="fig">
    <svg :viewBox="`0 0 700 ${30 + stages.length * PITCH + BOX_H + 20}`" role="img" :aria-label="aria">
      <defs>
        <marker id="pp-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <rect class="pbox pbox--source" :x="X" :y="top(0)" :width="BOX_W" :height="BOX_H" rx="10" />
      <text class="t-tag" :x="X + 18" :y="top(0) + 22">{{ source.tag }}</text>
      <text class="t-title" :x="X + 18" :y="top(0) + 44">{{ source.title }}</text>
      <text v-for="(l, j) in source.sub" :key="l" class="t-sub" :x="X + 18" :y="top(0) + 62 + j * 16">{{ l }}</text>

      <path class="flowline dashed" :d="`M${X + BOX_W} ${top(0) + BOX_H / 2} H${X + BOX_W + 34}`" marker-end="url(#pp-arw)" />
      <text class="t-edge" :x="X + BOX_W + 17" :y="top(0) + BOX_H / 2 - 9" text-anchor="middle">{{ toReview }}</text>

      <rect class="pbox pbox--review" :x="X + BOX_W + 42" :y="top(0)" width="268" :height="BOX_H" rx="10" />
      <text class="t-tag t-tag--review" :x="X + BOX_W + 60" :y="top(0) + 22">{{ review.tag }}</text>
      <text class="t-title" :x="X + BOX_W + 60" :y="top(0) + 44">{{ review.title }}</text>
      <text v-for="(l, j) in review.sub" :key="l" class="t-sub" :x="X + BOX_W + 60" :y="top(0) + 62 + j * 16">{{ l }}</text>

      <g v-for="(s, i) in stages" :key="s.title">
        <path class="flowline" :d="`M${X + 44} ${top(i) + BOX_H} V${top(i + 1) - 4}`" marker-end="url(#pp-arw)" />
        <text class="t-edge" :x="X + 56" :y="top(i) + BOX_H + 26">{{ s.edge }}</text>

        <rect class="pbox" :class="{ 'pbox--runtime': i === stages.length - 1 }" :x="X" :y="top(i + 1)" :width="BOX_W" :height="BOX_H" rx="10" />
        <text class="t-tag" :x="X + 18" :y="top(i + 1) + 22">{{ s.tag }}</text>
        <text class="t-title" :x="X + 18" :y="top(i + 1) + 44">{{ s.title }}</text>
        <text v-for="(l, j) in s.sub" :key="l" class="t-sub" :x="X + 18" :y="top(i + 1) + 62 + j * 16">{{ l }}</text>
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

.pbox { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1.4; }
.pbox--source { stroke: var(--layer-vertical); stroke-opacity: .6; }
.pbox--runtime { stroke: var(--layer-kernel); stroke-opacity: .7; stroke-width: 1.8; }
/* The review branch ends in a person, so it is drawn as an aside, not a stage. */
.pbox--review { fill: var(--surface-inset); stroke-dasharray: 6 4; }

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
.t-tag--review { fill: var(--layer-vertical); }
</style>
