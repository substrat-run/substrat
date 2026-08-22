<script setup lang="ts">
// One drawing for every engine state machine. Nothing here is positioned by
// hand and nothing is positioned by a general-purpose graph layout either:
// these machines are a spine with branches falling off it, so the geometry says
// exactly that. A row is as tall as its branch count, which is the only reason
// the vertical rhythm varies.
//
// The machine itself comes from ./StateMachine.content.mts — emitted from
// model.json where the engine declares a lifecycle, transcribed where it does
// not, and the page says which.
import { computed } from 'vue';
import { diagramFor, emittedNote, transcribedNote } from './StateMachine.content.mjs';
import { layout, verb } from './state-machine.mjs';

const props = defineProps<{ engine: string }>();

const BOX_H = 44;
const BRANCH_PITCH = 56;
const GAP = 42;
const SPINE_X = 100;
const SPINE_W = 200;
const BRANCH_X = 392;
const BRANCH_W = 236;

const view = computed(() => {
  const d = diagramFor(props.engine);
  const l = layout(d.machine);

  const branchesOf = (state: string) => l.branches.filter((b) => b.from === state);
  const rows = l.spine.map((state, i) => ({ state, i, branches: branchesOf(state) }));

  let y = 30;
  const placed = rows.map((r) => {
    const at = y;
    y += Math.max(1, r.branches.length) * BRANCH_PITCH + GAP;
    return { ...r, y: at };
  });
  const yOf = (state: string) => placed.find((p) => p.state === state)?.y ?? 0;

  return {
    d,
    machine: d.machine,
    placed,
    spineEdges: l.spineEdges.map((e, i) => ({
      ...e,
      from: placed[i]!.y + BOX_H,
      to: placed[i + 1]!.y,
    })),
    rejoins: l.rejoins.map((e, i) => ({
      ...e,
      y1: yOf(e.from) + BOX_H / 2,
      y2: yOf(e.to) + BOX_H / 2,
      x: 74 - i * 22,
    })),
    terminal: (s: string) => Boolean(d.machine.states[s]?.terminal),
    // Out of the drawing on purpose: these operations are legal in a state and
    // move nothing, so they are not edges. Rendering them beside the spine put
    // two unrelated labels in the same place and read as though they were.
    allows: Object.entries(d.machine.states)
      .filter(([, st]) => st.allow?.length)
      .map(([state, st]) => ({ state, ops: st.allow!.map(verb) })),
    height: y - GAP + 20,
    aria:
      `The ${d.entity} state machine on ${d.machine.field}. It runs ` +
      `${l.spine.join(', then ')}. ` +
      (l.branches.length
        ? `States leaving that run: ${l.branches.map((b) => `${b.from} to ${b.to} on ${verb(b.op)}`).join('; ')}.`
        : 'No state leaves that run.'),
  };
});
</script>

<template>
  <figure class="fig">
    <svg :viewBox="`0 0 700 ${view.height}`" role="img" :aria-label="view.aria">
      <defs>
        <marker id="sm-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto">
          <polygon class="mk" points="0 0, 9 3.5, 0 7" />
        </marker>
      </defs>

      <!-- rejoins: an edge that skips ahead on the spine or loops back to it -->
      <g v-for="r in view.rejoins" :key="r.from + r.op">
        <path
          class="flowline dashed"
          :d="`M${SPINE_X} ${r.y1} H${r.x} V${r.y2} H${SPINE_X - 4}`"
          marker-end="url(#sm-arw)"
        />
        <text class="t-edge" :x="r.x - 6" :y="(r.y1 + r.y2) / 2" text-anchor="end">{{ verb(r.op) }}</text>
      </g>

      <!-- the spine -->
      <g v-for="p in view.placed" :key="p.state">
        <rect
          class="sbox" :class="{ 'sbox--terminal': view.terminal(p.state), 'sbox--initial': p.i === 0 }"
          :x="SPINE_X" :y="p.y" :width="SPINE_W" :height="BOX_H" rx="9"
        />
        <text class="t-state" :x="SPINE_X + 16" :y="p.y + 27">{{ p.state }}</text>

        <!-- branches off this state -->
        <g v-for="(b, j) in p.branches" :key="b.op + b.to">
          <path
            class="flowline"
            :d="`M${SPINE_X + SPINE_W} ${p.y + BOX_H / 2} H${BRANCH_X - 40} V${p.y + j * BRANCH_PITCH + BOX_H / 2} H${BRANCH_X - 4}`"
            marker-end="url(#sm-arw)"
          />
          <text class="t-edge" :x="SPINE_X + SPINE_W + 10" :y="p.y + j * BRANCH_PITCH + BOX_H / 2 - 6">{{ verb(b.op) }}</text>
          <rect
            class="sbox sbox--off" :class="{ 'sbox--terminal': view.terminal(b.to) }"
            :x="BRANCH_X" :y="p.y + j * BRANCH_PITCH" :width="BRANCH_W" :height="BOX_H" rx="9"
          />
          <text class="t-state" :x="BRANCH_X + 16" :y="p.y + j * BRANCH_PITCH + 27">{{ b.to }}</text>
        </g>
      </g>

      <!-- spine edges -->
      <g v-for="e in view.spineEdges" :key="e.op">
        <path class="flowline" :d="`M${SPINE_X + 44} ${e.from} V${e.to - 4}`" marker-end="url(#sm-arw)" />
        <text class="t-edge" :x="SPINE_X + 54" :y="e.from + 20">{{ verb(e.op) }}</text>
      </g>
    </svg>
    <ul v-if="view.allows.length" class="allows">
      <li v-for="a in view.allows" :key="a.state">
        <code>{{ a.state }}</code> admits {{ a.ops.join(' · ') }} — none of which move it
      </li>
    </ul>
    <figcaption>
      <code>{{ view.machine.field }}</code> · starts at <code>{{ view.machine.initial }}</code>.
      {{ view.d.declared ? emittedNote : transcribedNote }}
    </figcaption>
  </figure>
</template>

<style scoped>
.fig { margin: 24px 0 26px; overflow-x: auto; font-family: var(--font-sans); }
.fig svg { display: block; width: 100%; max-width: 700px; height: auto; }
.fig figcaption {
  font-size: var(--text-sm); line-height: var(--lh-sm);
  color: var(--text-tertiary); margin-top: 12px; max-width: 62ch;
}
.fig figcaption code {
  font-family: var(--font-mono); font-size: 0.9em;
  background: var(--surface-inset); border-radius: 4px; padding: 1px 5px;
}

/* The spine is the engine's own colour; a state that leaves it is neutral, and
   a terminal state is dashed — nothing continues from it. */
.sbox { fill: var(--surface-card); stroke: var(--layer-engine); stroke-opacity: .55; stroke-width: 1.4; }
.sbox--initial { stroke-opacity: 1; stroke-width: 2; }
.sbox--off { stroke: var(--border-strong); stroke-opacity: 1; }
.sbox--terminal { stroke-dasharray: 5 4; }

.flowline { fill: none; stroke: var(--border-strong); stroke-width: 1.7; }
.flowline.dashed { stroke-dasharray: 4 4; stroke-width: 1.3; }
.mk { fill: var(--border-strong); }

.t-state { fill: var(--text-primary); font: var(--weight-medium) 13px var(--font-mono); }
.t-edge  { fill: var(--text-secondary); font: var(--weight-regular) 11px var(--font-sans); }
.allows {
  list-style: none; margin: 14px 0 0; padding: 0;
  display: grid; gap: 6px;
  font-size: var(--text-sm); line-height: var(--lh-sm); color: var(--text-tertiary);
}
.allows code {
  font-family: var(--font-mono); font-size: 0.92em;
  background: var(--surface-inset); border-radius: 4px; padding: 1px 5px;
  color: var(--text-secondary);
}
</style>
