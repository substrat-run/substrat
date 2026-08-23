<script setup lang="ts">
// The line, as a figure: what an agent writes above it, what the substrate owns
// below it, and the cost of a mistake on each side. Colors come from the design
// tokens' --layer-* accents (vertical amber above, kernel indigo below) so the
// figure reads as the same system as the three-layer stack and flips with theme.
//
// Every string it renders lives in ./BlastRadius.content.mts, because llms.mts
// flattens that module into the page's markdown twin. A fact typed into this
// template renders here and vanishes from llms.txt. Put it in the data module.
import { above, below, captionHtml, theLine } from './BlastRadius.content.mjs';
</script>

<template>
  <figure class="blast">
    <section class="side side--above">
      <header>
        <h3>{{ above.name }}</h3>
        <span class="verdict">{{ above.verdict }}</span>
      </header>
      <div class="chips">
        <span v-for="c in above.chips" :key="c" class="chip">{{ c }}</span>
      </div>
    </section>

    <div class="divider">
      <span class="label">{{ theLine.label }}</span>
      <span class="rule" aria-hidden="true"></span>
      <span class="label">guarantees below · velocity above</span>
    </div>

    <section class="side side--below">
      <header>
        <h3>{{ below.name }}</h3>
        <span class="verdict">{{ below.verdict }}</span>
      </header>
      <div class="chips">
        <span v-for="c in below.chips" :key="c" class="chip">{{ c }}</span>
      </div>
    </section>

    <figcaption v-html="captionHtml"></figcaption>
  </figure>
</template>

<style scoped>
.blast {
  margin: 24px 0 8px;
  font-family: var(--font-sans);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-card);
}

.side { padding: 16px 18px; display: grid; gap: 10px; }
.side--above { background: color-mix(in srgb, var(--layer-vertical) 7%, var(--surface-card)); }
.side--below { background: color-mix(in srgb, var(--layer-kernel) 7%, var(--surface-card)); }

.side header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; }
.side h3 {
  margin: 0;
  font-size: var(--text-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  border: 0;
  padding: 0;
}
.side--above h3 { color: var(--layer-vertical); }
.side--below h3 { color: var(--layer-kernel); }

.verdict {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  font-weight: var(--weight-medium);
  padding: 3px 9px;
  border-radius: 99px;
}
.side--above .verdict {
  color: var(--layer-vertical);
  background: color-mix(in srgb, var(--layer-vertical) 15%, transparent);
}
.side--below .verdict {
  color: var(--layer-kernel);
  background: color-mix(in srgb, var(--layer-kernel) 15%, transparent);
}

.chips { display: flex; flex-wrap: wrap; gap: 7px; }
.chip {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  padding: 4px 10px;
  border-radius: 7px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 18px;
  border-block: 1px solid var(--border-strong);
  background: var(--surface-card);
}
.divider .label {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  white-space: nowrap;
}
.divider .rule {
  flex: 1;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--layer-vertical), var(--layer-engine), var(--layer-kernel));
}

figcaption {
  padding: 13px 18px;
  border-top: 1px solid var(--border-subtle);
  background: var(--surface-inset);
  font-size: var(--text-base);
  line-height: var(--lh-base);
  color: var(--text-secondary);
}
figcaption :deep(code) { font-size: var(--text-sm); }

@media (max-width: 560px) {
  .divider { flex-wrap: wrap; gap: 8px; }
  .divider .rule { order: 3; flex-basis: 100%; }
}
</style>
