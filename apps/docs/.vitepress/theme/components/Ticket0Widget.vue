<script setup lang="ts">
/**
 * The ticket0 support widget, on this page only.
 *
 * The site-wide embed is `TICKET0_WIDGET=1` in `config.mts`, which puts the tag in
 * every page's `<head>`. This is the per-page form: a component the page mounts, so a
 * test page can carry the widget while the rest of the site does not.
 *
 * It appends the same `<script>` the ticket0 README documents — nothing else, so the
 * two forms cannot drift — and on the way out calls the one verb the script exposes
 * for a client-side router. Without that, VitePress would navigate away and leave the
 * bubble, and its poll, on every page after this one.
 */
import { onBeforeUnmount, onMounted } from 'vue';

const props = defineProps<{
  /** The desk's origin — `https://ticket0.substrat.net`. The script is `${desk}/widget.js`. */
  desk: string;
}>();

declare global {
  interface Window {
    ticket0?: { unmount(): void };
  }
}

let tag: HTMLScriptElement | undefined;

onMounted(() => {
  tag = document.createElement('script');
  tag.src = `${props.desk.replace(/\/+$/, '')}/widget.js`;
  tag.defer = true;
  document.body.appendChild(tag);
});

onBeforeUnmount(() => {
  window.ticket0?.unmount();
  tag?.remove();
  tag = undefined;
});
</script>

<template>
  <!-- Nothing to render here: the script appends its own host to document.body. -->
  <span class="ticket0-widget" aria-hidden="true" />
</template>
