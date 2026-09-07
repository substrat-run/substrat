<script setup lang="ts">
/**
 * The signup form — a place on the private beta's waiting list, or the weekly
 * changelog by email.
 *
 * It posts to substrat.net's own ticket0 desk, which is the same desk the support
 * widget on `/guide/support` talks to and the same one the docs site is the knowledge
 * base for. That is deliberate rather than convenient: a list of real email addresses
 * wants the things a vertical already has — an origin allowlist in front of the write,
 * an erasable column behind it, an audit event per state change, and a GDPR erasure
 * that can actually reach it. A form service would have given us none of those, and a
 * `_headers` file cannot hold a waiting list.
 *
 * ## The origin is not sent, and that is the point
 *
 * The desk decides which sites may sign people up, out of its own allowlist, and the
 * only thing that says where this request came from is the `Origin` header the browser
 * attaches and the page cannot forge. So there is nothing here to spoof — no origin
 * field, no site id, no key. If substrat.net is not on the desk's list, this form does
 * not work, and no version of this component can talk it into working.
 *
 * ## Double opt-in, and why the copy says so
 *
 * Submitting does not put anybody on a list; it sends them a link. Until that link is
 * clicked the row is `pending` and no newsletter will ever reach it. The success text
 * says "check your inbox" rather than "you're on the list" because the second one
 * would be false, and the person would go looking for a confirmation email they had
 * been told they did not need.
 */
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Which list. `waitlist` also offers the free-text box. */
    kind: 'waitlist' | 'newsletter';
    /** The desk's origin — `https://ticket0.substrat.net`. Named in the page's CSP. */
    desk: string;
    /** The submit button's label. */
    cta?: string;
    /** The free-text prompt, waitlist only. Empty string turns the box off. */
    notePrompt?: string;
  }>(),
  {
    cta: '',
    notePrompt: 'What are you thinking of building? (optional)',
  },
);

const email = ref('');
const note = ref('');
const status = ref<'idle' | 'sending' | 'sent' | 'failed'>('idle');
const problem = ref('');

const label = computed(() => props.cta || (props.kind === 'waitlist' ? 'Request an invite' : 'Subscribe'));
const wantsNote = computed(() => props.kind === 'waitlist' && props.notePrompt !== '');

/** What the person is told when it worked. Both say the same thing: it is not done yet. */
const sentText = computed(() =>
  props.kind === 'waitlist'
    ? 'Check your inbox — confirm the link and you are on the list.'
    : 'Check your inbox — confirm the link and the changelog will arrive on Mondays.',
);

async function submit() {
  if (status.value === 'sending') return;
  status.value = 'sending';
  problem.value = '';
  try {
    const res = await fetch(`${props.desk.replace(/\/+$/, '')}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: props.kind,
        email: email.value.trim(),
        note: wantsNote.value && note.value.trim() ? note.value.trim() : null,
      }),
    });
    if (res.ok) {
      status.value = 'sent';
      return;
    }
    /**
     * The desk answers in problem+json. `detail` is the field RFC 9457 puts the
     * this-time explanation in; `error` is the deprecated twin the SPAs still read.
     * A 429 gets its own words because "something went wrong" is wrong — nothing did,
     * the desk is simply full for the hour.
     */
    const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
    problem.value =
      res.status === 429
        ? 'That is a lot of signups this hour. Try again shortly — nothing was lost.'
        : (body.detail ?? body.error ?? 'That did not go through. Try again in a moment.');
    status.value = 'failed';
  } catch {
    // A network failure, an offline browser, or a CSP that does not name this desk.
    // The last one is a build mistake rather than a visitor's problem, but it reaches
    // the visitor identically, so the text has to make sense for all three.
    problem.value = 'That did not go through — check your connection and try again.';
    status.value = 'failed';
  }
}
</script>

<template>
  <div class="signup" :class="`signup-${kind}`">
    <p v-if="status === 'sent'" class="sent" role="status">
      <span class="tick" aria-hidden="true">✓</span>{{ sentText }}
    </p>

    <form v-else class="form" @submit.prevent="submit">
      <div class="row">
        <label class="sr-only" :for="`signup-email-${kind}`">Email address</label>
        <input
          :id="`signup-email-${kind}`"
          v-model="email"
          class="field"
          type="email"
          name="email"
          autocomplete="email"
          required
          placeholder="you@company.com"
          :disabled="status === 'sending'"
        />
        <button class="btn btn-primary" type="submit" :disabled="status === 'sending'">
          {{ status === 'sending' ? 'Sending…' : label }}
        </button>
      </div>

      <label v-if="wantsNote" class="note-label" :for="`signup-note-${kind}`">
        <span class="sr-only">{{ notePrompt }}</span>
        <textarea
          :id="`signup-note-${kind}`"
          v-model="note"
          class="field note"
          rows="2"
          :placeholder="notePrompt"
          :disabled="status === 'sending'"
        />
      </label>

      <p class="fine">
        We send one confirmation email, and nothing else until you click it.
        Every message after that has an unsubscribe link that always works.
      </p>

      <p v-if="status === 'failed'" class="failed" role="alert">{{ problem }}</p>
    </form>
  </div>
</template>

<style scoped>
.signup {
  max-width: 560px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.field {
  flex: 1 1 220px;
  /* The note box is a block on its own line rather than a flex item, so the basis
     above does nothing for it — without this it shrinks to fit its placeholder and
     sits at half the width of the row above. */
  box-sizing: border-box;
  width: 100%;
  height: var(--control-h-lg);
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
  color: var(--text-primary);
  font-size: var(--text-base);
  font-family: inherit;
}
.field:focus {
  outline: 2px solid var(--text-brand);
  outline-offset: 1px;
  border-color: transparent;
}
.field:disabled {
  opacity: 0.6;
}
.note {
  height: auto;
  padding: 10px 12px;
  line-height: var(--lh-base);
  resize: vertical;
}
.note-label {
  display: block;
  width: 100%;
}
.btn {
  display: inline-flex;
  align-items: center;
  height: var(--control-h-lg);
  padding: 0 18px;
  border: 0;
  border-radius: var(--radius-sm);
  font-weight: var(--weight-medium);
  font-size: var(--text-base);
  font-family: inherit;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.btn-primary {
  background: var(--action-primary-bg);
  color: var(--action-primary-text);
  box-shadow: var(--shadow-xs);
}
.btn-primary:hover:not(:disabled) {
  background: var(--action-primary-bg-hover);
}
.btn:disabled {
  cursor: default;
  opacity: 0.7;
}
.fine,
.failed,
.sent {
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
  margin: 0;
}
.fine {
  color: var(--text-tertiary);
}
.failed {
  color: var(--status-danger-fg);
}
.sent {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--text-secondary);
}
.tick {
  color: var(--text-brand);
  font-weight: var(--weight-semibold);
}
/* Visible to a screen reader, not to the page — the inputs carry their prompt in a
   placeholder, which is a hint rather than a label and is not read as one. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
