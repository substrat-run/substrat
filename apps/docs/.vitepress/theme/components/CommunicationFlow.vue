<script setup lang="ts">
import { computed } from 'vue';
import { flowFor } from './CommunicationFlow.content.mjs';

const props = withDefaults(defineProps<{ kind?: string }>(), { kind: 'peer' });
const flow = computed(() => flowFor(props.kind));
const rowY = (i: number) => 52 + i * 172;
const height = computed(() => rowY(flow.value.steps.length - 1) + 126);
</script>

<template>
  <figure class="communication">
    <svg :viewBox="`0 0 440 ${height}`" role="img" :aria-label="flow.aria">
      <text class="heading" x="12" y="27">{{ flow.title }}</text>
      <g v-for="(step, i) in flow.steps" :key="step.owner" :class="`step step--${step.layer}`">
        <rect class="card" x="12" :y="rowY(i)" width="416" height="120" rx="10" />
        <rect class="accent" x="12" :y="rowY(i) + 12" width="4" height="96" rx="2" />
        <circle class="badge" cx="40" :cy="rowY(i) + 25" r="12" />
        <text class="number" x="40" :y="rowY(i) + 30" text-anchor="middle">{{ i + 1 }}</text>
        <text class="owner" x="62" :y="rowY(i) + 30">{{ step.owner }}</text>
        <text class="title" x="30" :y="rowY(i) + 59">{{ step.title }}</text>
        <text v-for="(line, j) in step.lines" :key="line" class="detail" x="30" :y="rowY(i) + 83 + j * 22">{{ line }}</text>
        <g v-if="flow.edges[i]">
          <path class="arrow" :d="`M40 ${rowY(i) + 120} v43 m-5 -6 l5 6 l5 -6`" />
          <text class="edge" x="62" :y="rowY(i) + 151">{{ flow.edges[i] }}</text>
        </g>
      </g>
    </svg>
    <figcaption>{{ flow.caption }}</figcaption>
  </figure>
</template>

<style scoped>
.communication { margin: 28px 0; font-family: var(--font-sans); }
.communication svg { display: block; width: 100%; height: auto; }
.communication figcaption { margin-top: 12px; color: var(--text-secondary); font-size: 14px; line-height: 1.55; }
.heading { fill: var(--text-primary); font-size: 21px; font-weight: 600; }
.step--vertical { --flow-color: var(--layer-vertical); }
.step--kernel { --flow-color: var(--layer-kernel); }
.step--engine { --flow-color: var(--layer-engine); }
.card { fill: var(--surface-card); stroke: var(--border-strong); stroke-width: 1.2; }
.accent { fill: var(--flow-color); }
.badge { fill: var(--surface-inset); stroke: var(--flow-color); }
.number { fill: var(--text-primary); font-size: 14px; font-weight: 600; }
.owner { fill: var(--text-secondary); font-size: 13px; font-weight: 600; letter-spacing: .5px; }
.title { fill: var(--text-primary); font-size: 20px; font-weight: 600; }
.detail { fill: var(--text-secondary); font-size: 17px; }
.edge { fill: var(--text-secondary); font-size: 16px; }
.arrow { fill: none; stroke: var(--text-secondary); stroke-width: 1.5; }
</style>
