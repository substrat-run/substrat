<script setup lang="ts">
// The three-layer model as a stratified diagram: verticals above the line,
// engines + kernel + adapters below it, connectors at the edge. Every label is a
// real, shipping package; the chip copy is checked against the repo. Colors come
// from the design tokens' --layer-* accents (kernel indigo, engine cyan, vertical
// amber) so this reads the same as the rest of the docs and flips with the theme.
//
// Every string it renders lives in ./LayerStack.content.mts, because llms.mts
// flattens that module into the page's markdown twin. A fact typed into this
// template renders here and vanishes from llms.txt. Put it in the data module.
import {
  adapters, connectors, engines, kernel, laws, lawsHead, seams, theLine, verticals,
} from './LayerStack.content.mjs';
</script>

<template>
  <div class="layerstack">
    <!-- Verticals -->
    <section class="layer layer--vertical">
      <div class="rail">
        <p class="lname">{{ verticals.name }}</p>
        <p class="lrole" v-html="verticals.role"></p>
        <p class="lowner">{{ verticals.owner }}</p>
      </div>
      <div class="chips">
        <span v-for="[name, sub] in verticals.chips" :key="name" class="chip">
          <b>{{ name }}</b><em>{{ sub }}</em>
        </span>
      </div>
    </section>

    <!-- The line -->
    <div class="theline"><span>{{ theLine.label }}</span></div>
    <div class="sides">
      <span class="up"><b>Above &uarr;</b> {{ theLine.above }}</span>
      <span class="down"><b>&darr; Below</b> {{ theLine.below }}</span>
    </div>
    <p class="seam">{{ seams.verticalToEngine }}</p>

    <!-- Engines -->
    <section class="layer layer--engine">
      <div class="rail">
        <p class="lname">{{ engines.name }}</p>
        <p class="lrole" v-html="engines.role"></p>
        <p class="lowner">{{ engines.owner }}</p>
      </div>
      <div class="chips">
        <span v-for="[name, sub] in engines.chips" :key="name" class="chip">
          <b>{{ name }}</b><em>{{ sub }}</em>
        </span>
      </div>
    </section>

    <p class="seam" v-html="seams.engineToKernel"></p>

    <!-- Kernel -->
    <section class="layer layer--kernel bedrock">
      <div class="rail">
        <p class="lname">{{ kernel.name }}</p>
        <p class="lrole" v-html="kernel.role"></p>
        <p class="lowner">{{ kernel.owner }}</p>
      </div>
      <div>
        <div class="chips kbits">
          <span v-for="b in kernel.bits" :key="b" class="kchip">{{ b }}</span>
        </div>
        <div class="ctx">
          <span class="ctxlabel">{{ kernel.ctxLabel }}</span>
          <code v-for="c in kernel.ctx" :key="c">{{ c }}</code>
        </div>
        <p class="knote">{{ kernel.note }}</p>
      </div>
    </section>

    <p class="seam">{{ seams.kernelToAdapter }}</p>

    <!-- Adapters -->
    <section class="layer layer--adapter">
      <div class="rail">
        <p class="lname">{{ adapters.name }}</p>
        <p class="lrole" v-html="adapters.role"></p>
        <p class="lowner">{{ adapters.owner }}</p>
      </div>
      <div class="chips">
        <span v-for="[name, sub] in adapters.chips" :key="name" class="chip">
          <b>{{ name }}</b><em>{{ sub }}</em>
        </span>
      </div>
    </section>

    <!-- Connectors -->
    <section class="layer layer--connector edge">
      <div class="rail">
        <p class="lname">{{ connectors.name }}</p>
        <p class="lrole" v-html="connectors.role"></p>
        <p class="lowner">{{ connectors.owner }}</p>
      </div>
      <div class="chips">
        <span v-for="[name, sub] in connectors.chips" :key="name" class="chip">
          <b>{{ name }}</b><em>{{ sub }}</em>
        </span>
      </div>
    </section>

    <!-- Laws -->
    <div class="laws">
      <p class="lawshead">{{ lawsHead }}</p>
      <ol>
        <li v-for="([head, body], i) in laws" :key="i">
          <span class="n">{{ i + 1 }}</span>
          <span><b>{{ head }}</b> {{ body }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.layerstack {
  display: flex;
  flex-direction: column;
  margin: 24px 0 8px;
  font-family: var(--font-sans);
}

.layer {
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 20px;
  border: 1px solid var(--border-default);
  border-left: 3px solid var(--accent, var(--border-strong));
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--surface-card);
}
.layer--vertical { --accent: var(--layer-vertical); }
.layer--engine   { --accent: var(--layer-engine); }
.layer--kernel   { --accent: var(--layer-kernel); }
.layer--adapter  { --accent: var(--text-tertiary); }
.layer--connector { --accent: var(--layer-vertical); border-style: dashed; }

.rail { min-width: 0; }
.lname {
  font-size: var(--text-lg);
  line-height: var(--lh-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--accent);
  margin: 0 0 4px;
}
.lrole { font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-secondary); margin: 0 0 8px; }
.lrole em { color: var(--text-primary); font-style: italic; }
.lowner { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; font-weight: var(--weight-semibold); color: var(--text-tertiary); margin: 0; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; }
.chip {
  display: flex; flex-direction: column; gap: 1px;
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 7px 10px;
  min-width: 0;
}
.chip b { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-primary); }
.layer--engine .chip b { color: var(--layer-engine); }
.chip em { font-size: var(--text-xs); line-height: var(--lh-xs); color: var(--text-tertiary); font-style: normal; }

/* Kernel — bedrock treatment. Pinned to a constant deep scale value (not the
   theme-flipping --surface-inverse, which goes near-white in dark mode and would
   swallow the white text). Bedrock reads dark in both themes, by design. */
.bedrock { background: var(--gray-900); border-color: var(--gray-800); }
.bedrock .lname { color: #fff; }
.bedrock .lrole { color: rgba(255,255,255,.82); }
.bedrock .lrole em { color: #fff; }
.bedrock .lowner { color: rgba(255,255,255,.55); }
.kbits { gap: 6px; }
.kchip {
  font-size: var(--text-sm);
  color: rgba(255,255,255,.9);
  background: rgba(255,255,255,.07);
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 7px;
  padding: 5px 9px;
}
.ctx { margin-top: 11px; padding-top: 11px; border-top: 1px dashed rgba(255,255,255,.18); display: flex; flex-wrap: wrap; gap: 7px 14px; align-items: baseline; }
.ctxlabel { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: rgba(255,255,255,.55); font-weight: var(--weight-semibold); }
.ctx code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: #fff;
  background: rgba(255,255,255,.12);
  padding: 1px 7px;
  border-radius: 5px;
}
.knote { margin: 11px 0 0; font-size: var(--text-sm); line-height: var(--lh-sm); color: rgba(255,255,255,.62); font-style: italic; }

/* The line */
.theline { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 14px; margin: 10px 2px; }
.theline::before, .theline::after { content: ""; border-top: 2px dashed var(--layer-vertical); opacity: .5; }
.theline span { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--layer-vertical); font-weight: var(--weight-bold); }
.sides { display: flex; justify-content: space-between; gap: 14px; margin: 0 4px; font-size: var(--text-sm); line-height: var(--lh-sm); color: var(--text-tertiary); }
.sides .down { text-align: right; }
.sides .up b { color: var(--layer-vertical); }
.sides .down b { color: var(--layer-engine); }

.seam { text-align: center; font-size: var(--text-xs); color: var(--text-tertiary); margin: 6px 0; }
.seam b { color: var(--text-secondary); font-weight: var(--weight-semibold); }

/* Laws */
.laws { margin-top: 26px; }
.lawshead { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; font-weight: var(--weight-bold); color: var(--text-primary); margin: 0 0 14px; }
.laws ol { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
.laws li { display: grid; grid-template-columns: 22px 1fr; gap: 10px; font-size: var(--text-base); line-height: var(--lh-base); color: var(--text-secondary); }
.laws .n { font-weight: var(--weight-bold); color: var(--layer-kernel); font-variant-numeric: tabular-nums; }
.laws b { color: var(--text-primary); font-weight: var(--weight-semibold); }

@media (max-width: 640px) {
  .layer { grid-template-columns: 1fr; gap: 12px; }
  .laws ol { grid-template-columns: 1fr; }
  .sides { flex-direction: column; gap: 4px; }
  .sides .down { text-align: left; }
}
</style>
