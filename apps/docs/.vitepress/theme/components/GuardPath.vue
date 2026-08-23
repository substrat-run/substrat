<script setup lang="ts">
// The six guards as the path a change walks, numbered because they are a real
// sequence in time rather than a set of categories — the page's claim is that a
// mistake surviving one stage meets the next, and the ordering carries it.
//
// Every string it renders lives in ./GuardPath.content.mts, because llms.mts
// flattens that module into the page's markdown twin. A fact typed into this
// template renders here and vanishes from llms.txt. Put it in the data module.
import { guards } from './GuardPath.content.mjs';
</script>

<template>
  <ol class="path">
    <li v-for="(g, i) in guards" :key="g.when" class="guard">
      <div class="stage">
        <span class="num">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="when">{{ g.when }}</span>
      </div>
      <div class="body">
        <h3>{{ g.title }}</h3>
        <p class="prose" v-html="g.body"></p>
        <p class="stops"><b>Stops</b><span>{{ g.stops }}</span></p>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.path {
  list-style: none;
  margin: 24px 0 8px;
  padding: 0;
  font-family: var(--font-sans);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-card);
  counter-reset: none;
}

.guard {
  display: grid;
  grid-template-columns: 104px 1fr;
  border-bottom: 1px solid var(--border-subtle);
  margin: 0;
}
.guard:last-child { border-bottom: 0; }

.stage {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 0 16px 18px;
  border-right: 1px solid var(--border-subtle);
  background: var(--surface-inset);
}
.num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
}
.when {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.body { padding: 16px 18px; display: grid; gap: 8px; }
.body h3 {
  margin: 0;
  font-size: var(--text-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  border: 0;
  padding: 0;
}
.prose {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--lh-base);
  color: var(--text-secondary);
}
.prose :deep(code) { font-size: var(--text-sm); }
.prose :deep(em) { color: var(--text-primary); font-style: italic; }

.stops {
  margin: 2px 0 0;
  display: flex;
  gap: 9px;
  align-items: baseline;
  font-size: var(--text-base);
  line-height: var(--lh-base);
  color: var(--text-secondary);
}
.stops b {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  font-weight: var(--weight-medium);
  color: var(--status-danger-fg);
}

@media (max-width: 560px) {
  .guard { grid-template-columns: 1fr; }
  .stage {
    flex-direction: row;
    align-items: baseline;
    gap: 9px;
    padding: 11px 18px;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }
}
</style>
