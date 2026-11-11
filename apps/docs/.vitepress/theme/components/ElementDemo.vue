<script setup lang="ts">
/**
 * One live `@substrat-run/elements` demo: the real element, in a frame with a theme picker
 * that follows the site's light and dark mode, and a log of the events it fires. The
 * elements load in the browser only (`element-demos.ts` says why).
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useData } from 'vitepress';
import type { DemoName } from './element-demos';

const props = defineProps<{ name: DemoName }>();
const { isDark } = useData();

const THEMES = [
  { id: '', label: 'Web Awesome' },
  { id: 'sub-theme-ledger', label: 'Ledger' },
  { id: 'sub-theme-atelier', label: 'Atelier' },
  { id: 'sub-theme-native', label: 'Native' },
];
const theme = ref('');
const stage = ref<HTMLElement>();
const lines = ref<string[]>([]);
const failed = ref(false);
let unmount: (() => void) | undefined;

onMounted(async () => {
  try {
    const { mountDemo } = await import('./element-demos');
    if (!stage.value) return;
    unmount = mountDemo(props.name, stage.value, (line) => {
      lines.value = [line, ...lines.value].slice(0, 6);
    });
  } catch (error) {
    console.error(error);
    failed.value = true;
  }
});

onBeforeUnmount(() => unmount?.());
</script>

<template>
  <div class="element-demo">
    <div class="element-demo-bar">
      <span class="element-demo-tag">Live</span>
      <label class="element-demo-theme">
        <span>Theme</span>
        <select v-model="theme">
          <option v-for="t in THEMES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </label>
    </div>
    <div ref="stage" class="element-demo-stage" :class="[isDark ? 'wa-dark' : 'wa-light', theme]">
      <p v-if="failed" class="element-demo-failed">The demo could not load in this browser.</p>
    </div>
    <ol v-if="lines.length" class="element-demo-log" aria-label="Events" aria-live="polite">
      <li v-for="(line, i) in lines" :key="lines.length - i">{{ line }}</li>
    </ol>
  </div>
</template>

<style scoped>
.element-demo {
  margin: 20px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
}
.element-demo-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.element-demo-tag {
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 11px;
}
.element-demo-theme {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.element-demo-bar select {
  width: auto;
  appearance: auto;
  font: inherit;
  padding: 2px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}
.element-demo-stage {
  padding: 16px;
  background: var(--wa-color-surface-default);
  color: var(--wa-color-text-normal);
  font-family: var(--wa-font-family-body);
  min-height: 4rem;
}
.element-demo-stage :deep(.demo-stack) {
  display: grid;
  gap: 12px;
}
.element-demo-stage :deep(.demo-row) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20px;
}
.element-demo-stage :deep(.demo-header) {
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid var(--wa-color-surface-border);
  border-radius: var(--wa-border-radius-m);
}
.element-demo-stage :deep(.demo-option) {
  font-size: var(--wa-font-size-s);
  color: var(--wa-color-text-quiet);
}
.element-demo-failed {
  margin: 0;
  color: var(--vp-c-text-2);
}
.element-demo-log {
  margin: 0;
  padding: 8px 12px;
  list-style: none;
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  overflow-x: auto;
}
.element-demo-log li {
  white-space: nowrap;
}
.element-demo-log li:first-child {
  color: var(--vp-c-text-1);
}
</style>
