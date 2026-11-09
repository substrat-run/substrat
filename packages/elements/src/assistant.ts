/**
 * `<sub-assistant>` — a conversation with the assistant: the transcript and the box to type
 * in, and nothing around them. It has no popup, modal or sidebar mode. It fills the box it is
 * given, and the host wraps it in a `wa-dialog`, a `wa-drawer`, its own palette or a page.
 *
 * A renderer over `AssistantModel`: it draws the snapshot and forwards clicks. Styled only
 * through Web Awesome's `--wa-*` tokens, with a readable fallback for each, and it loads no Web
 * Awesome component: a host on another stack maps its colours onto those tokens and is done.
 *
 * Property: `model` — an `AssistantModel`. The host creates it and keeps it, so taking the
 *   element out of the page keeps the conversation; a new model is a new conversation.
 *   `labels` — a partial `AssistantLabels` over the English defaults.
 * Attributes: `label` (the transcript's accessible name), `placeholder`, `max-length`,
 *   `heading-level` (of the hidden per-message headings, 3 by default), `hide-composer` (for a
 *   host with its own input, which calls `model.send(text)`).
 * Slot: `empty` — what shows before the first question.
 * Event: `sub-assistant-source` `{ citation, turn }` when a source is clicked, cancelable: a
 *   citation with a `url` is a link, and `preventDefault()` keeps it from opening.
 * Method: `focus()` — the input, or the transcript under `hide-composer`.
 *
 * ## Keys
 *
 * Nothing here listens above the element. Enter on one of its own buttons is handled on the
 * button and marked with `preventDefault()`, so a palette listening at `window` can leave it
 * alone by checking `defaultPrevented`. A palette's preventDefault on that Enter would otherwise
 * keep the button from being pressed at all.
 *
 * ## What is announced
 *
 * The transcript is a labelled region and not a live one: streaming into a live region reads
 * out fragments. One `role="status"` node, empty until it has something to say and inside this
 * shadow root so a modal does not make it inert, says when a turn starts, ends or fails, and
 * that it is still working after a silence. The answer is read by moving to it.
 *
 * ## Styling, outside in
 *
 * The theme's `--wa-*` tokens; then `--sub-assistant-gap`; then `::part()` — `transcript`,
 * `turn`, `question`, `ai-marker`, `answer`, `trace`, `working`, `sources`, `source`,
 * `provenance`, `note`, `failure`, `retry`, `jump`, `composer`, `input`, `send`, `stop`.
 */
import { css, html, noChange, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { Directive, directive, type Part } from 'lit/directive.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  turnChange,
  type AssistantCitation,
  type AssistantFailure,
  type AssistantModel,
  type AssistantPart,
  type AssistantProvenance,
  type AssistantSnapshot,
  type AssistantTurn,
  type AssistantTurnChange,
} from './assistant-model.js';
import { isComposingEnter, type CompositionState } from './internal/composing.js';
import SubstratElement from './internal/substrat-element.js';

/** Every word the element says. Set `labels` to replace any of them. */
export interface AssistantLabels {
  conversation: string;
  you: string;
  assistant: string;
  aiMarker: string;
  input: string;
  send: string;
  stop: string;
  retry: string;
  jump: string;
  sources: string;
  /** Shown and announced while nothing has been written yet. */
  working: string;
  /** Announced after a long silence. */
  stillWorking: string;
  answered: string;
  stopped: string;
  endedEarly: string;
  needsApproval: string;
  /** The turn ended because the budget ran out. */
  budgetOut: string;
  /** The turn was answered, and that was the last one the budget allows. */
  budgetLast: string;
  failure(failure: AssistantFailure): string;
  tool(name: string, status: 'running' | 'done' | 'failed'): string;
  provenance(provenance: AssistantProvenance, lang: string | undefined): string;
}

const FAILURES: Readonly<Record<string, string>> = {
  transport: 'Could not reach the assistant.',
  refused: 'You do not have access to that.',
  'rate-limited': 'Too many questions. Try again in a moment.',
  unavailable: 'The assistant is not available right now.',
};

/** `list_findings` as a person says it. */
const toolName = (tool: string) => tool.replace(/_/g, ' ');

function defaultProvenance(p: AssistantProvenance, lang: string | undefined): string {
  const at = new Date(p.producedAt);
  const time = Number.isNaN(at.getTime()) ? '' : new Intl.DateTimeFormat(lang, { timeStyle: 'short' }).format(at);
  const from = p.sources === null ? '' : ` from ${p.sources} ${p.sources === 1 ? 'source' : 'sources'}`;
  const said = time || from ? `Answered${time ? ` ${time}` : ''}${from}` : '';
  const model = p.model?.split('/').pop();
  return [said, model].filter(Boolean).join(' · ');
}

const DEFAULT_LABELS: AssistantLabels = {
  conversation: 'Conversation',
  you: 'You said',
  assistant: 'The assistant said',
  aiMarker: 'AI',
  input: 'Ask a question',
  send: 'Send',
  stop: 'Stop',
  retry: 'Retry',
  jump: 'Jump to latest',
  sources: 'Sources',
  working: 'Working on it…',
  stillWorking: 'Still working.',
  answered: 'Answer ready.',
  stopped: 'Stopped.',
  endedEarly: 'The answer was cut off, so it may be incomplete.',
  needsApproval: 'This needs an approval that this version cannot show.',
  budgetOut: 'You have used your AI answers for now.',
  budgetLast: 'That was your last AI answer for now.',
  failure: (failure) => failure.message ?? FAILURES[failure.code] ?? 'The assistant could not answer.',
  tool: (name, status) => (status === 'running' ? `Using ${toolName(name)}…` : status === 'done' ? `Used ${toolName(name)}` : `Could not use ${toolName(name)}`),
  provenance: defaultProvenance,
};

/** How close to the bottom still counts as reading the latest, so a little drift does not stop the follow. */
const FOLLOW_WITHIN_PX = 48;

/** The silence before "still working" is announced, and the least time between two of them. */
const STILL_WORKING_MS = 10_000;

/**
 * Text that grows by appending to its one text node. Lit would assign `.data`, which replaces
 * the whole string and collapses a selection inside it, so anyone selecting the start of an
 * answer that is still being written would lose it on the next token.
 */
class GrowingText extends Directive {
  #node: Text | undefined;
  #text = '';

  render(text: string): unknown {
    return text;
  }

  override update(_part: Part, [text]: [string]): unknown {
    const node = this.#node;
    const before = this.#text;
    this.#text = text;
    if (!node) return (this.#node = document.createTextNode(text));
    if (text.startsWith(before)) node.appendData(text.slice(before.length));
    else node.data = text;
    return noChange;
  }
}

const growingText = directive(GrowingText);

type Block = { kind: 'text'; id: string; text: string } | { kind: 'trace'; id: string; parts: Exclude<AssistantPart, { kind: 'text' }>[] };

/** Text as it was written, with each run of tool calls and notes between it folded into one line. */
function blocksOf(parts: readonly AssistantPart[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text) blocks.push({ kind: 'text', id: part.id, text: part.text });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'trace') last.parts.push(part);
    else blocks.push({ kind: 'trace', id: `trace-${part.id}`, parts: [part] });
  }
  return blocks;
}

export class SubAssistant extends SubstratElement {
  static properties = {
    model: { attribute: false },
    labels: { attribute: false },
    label: {},
    placeholder: {},
    maxLength: { attribute: 'max-length', type: Number },
    headingLevel: { attribute: 'heading-level', type: Number },
    hideComposer: { attribute: 'hide-composer', type: Boolean },
    announcement: { state: true },
    showJump: { state: true },
    draftEmpty: { state: true },
  };

  declare model: AssistantModel | undefined;
  declare labels: Partial<AssistantLabels> | undefined;
  declare label: string;
  declare placeholder: string;
  declare maxLength: number | undefined;
  declare headingLevel: number;
  declare hideComposer: boolean;
  declare announcement: string;
  declare showJump: boolean;
  declare draftEmpty: boolean;

  #snapshot: AssistantSnapshot | null = null;
  #subscribedTo: AssistantModel | undefined;
  #unsubscribe: (() => void) | undefined;
  #following = true;
  /** Where the follow last left the transcript. Content growing never moves it up; a reader does. */
  #pinnedAt = 0;
  #observer: ResizeObserver | undefined;
  #silence: ReturnType<typeof setTimeout> | undefined;
  readonly #composition: CompositionState = { composing: false, endedAt: null };

  constructor() {
    super();
    this.label = '';
    this.placeholder = '';
    this.headingLevel = 3;
    this.hideComposer = false;
    this.announcement = '';
    this.showJump = false;
    this.draftEmpty = true;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.#subscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#stopListening();
    this.#observer?.disconnect();
    this.#observer = undefined;
  }

  protected willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('model') && this.isConnected) this.#subscribe();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (!this.#observer && typeof ResizeObserver !== 'undefined') {
      this.#observer = new ResizeObserver(() => this.#keepUp());
      const transcript = this.#transcript;
      const content = this.renderRoot.querySelector('.turns');
      if (transcript) this.#observer.observe(transcript);
      if (content) this.#observer.observe(content);
    }
    this.#keepUp();
  }

  /** The input, or the transcript when the host owns the input. */
  override focus(options?: FocusOptions): void {
    if (!this.hasUpdated) {
      void this.updateComplete.then(() => this.focus(options));
      return;
    }
    (this.#field ?? this.#transcript)?.focus(options);
  }

  get #words(): AssistantLabels {
    return { ...DEFAULT_LABELS, ...this.labels };
  }

  get #transcript(): HTMLElement | null {
    return this.renderRoot.querySelector('.transcript');
  }

  get #field(): HTMLTextAreaElement | null {
    return this.renderRoot.querySelector('textarea');
  }

  /** A page can carry a malformed tag (`en_US`), and `Intl` throws on one in the middle of a render. */
  get #lang(): string | undefined {
    const lang = this.closest<HTMLElement>('[lang]')?.lang || document.documentElement.lang;
    try {
      return lang ? Intl.getCanonicalLocales(lang)[0] : undefined;
    } catch {
      return undefined;
    }
  }

  #subscribe(): void {
    if (this.#subscribedTo === this.model && this.#unsubscribe) return;
    this.#stopListening();
    this.#snapshot = null;
    this.#subscribedTo = this.model;
    this.#unsubscribe = this.model?.subscribe(this.#onSnapshot);
    if (!this.model) this.requestUpdate();
  }

  #stopListening(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    clearTimeout(this.#silence);
  }

  readonly #onSnapshot = (next: AssistantSnapshot): void => {
    const change = turnChange(this.#snapshot, next);
    this.#snapshot = next;
    if (change) this.#announceChange(change, next);
    if (change === 'started') this.#follow();
    this.#watchSilence(next);
    this.requestUpdate();
  };

  #announceChange(change: AssistantTurnChange, snapshot: AssistantSnapshot): void {
    const words = this.#words;
    const failure = snapshot.turns[snapshot.turns.length - 1]?.failure;
    const said: Record<AssistantTurnChange, string> = {
      started: words.working,
      answered: words.answered,
      stopped: words.stopped,
      'ended-early': words.endedEarly,
      failed: failure ? words.failure(failure) : '',
      budget: words.budgetOut,
      'needs-approval': words.needsApproval,
    };
    this.#say(said[change]);
  }

  /** The same words twice is no change to a live region; a trailing no-break space makes it one. */
  #say(text: string): void {
    this.announcement = text === this.announcement ? `${text} ` : text;
  }

  #watchSilence(snapshot: AssistantSnapshot): void {
    clearTimeout(this.#silence);
    if (!snapshot.running) return;
    this.#silence = setTimeout(() => {
      this.#say(this.#words.stillWorking);
      this.#watchSilence(snapshot);
    }, STILL_WORKING_MS);
  }

  #distanceFromEnd(transcript: HTMLElement): number {
    return transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
  }

  #follow(): void {
    this.#following = true;
    this.#pinnedAt = 0;
  }

  /**
   * Follow the answer while the reader is at the end of it, and offer the way back when they
   * are not. A render can land between a reader's scroll and its event, so having moved up
   * since the last pin counts as having left, or the next token would pull them back down.
   */
  #keepUp(): void {
    const transcript = this.#transcript;
    if (!transcript) return;
    if (this.#following && transcript.scrollTop < this.#pinnedAt - 1 && this.#distanceFromEnd(transcript) > FOLLOW_WITHIN_PX) this.#following = false;
    if (this.#following) {
      transcript.scrollTop = transcript.scrollHeight;
      this.#pinnedAt = transcript.scrollTop;
    } else {
      this.showJump = this.#distanceFromEnd(transcript) > FOLLOW_WITHIN_PX;
    }
  }

  #onScroll(): void {
    const transcript = this.#transcript;
    if (!transcript) return;
    this.#following = this.#distanceFromEnd(transcript) <= FOLLOW_WITHIN_PX;
    this.showJump = !this.#following;
  }

  #jump(): void {
    this.#follow();
    this.showJump = false;
    this.#keepUp();
    this.#transcript?.focus({ preventScroll: true });
  }

  /** Enter on a control of ours is ours: pressed here, and marked so a host's listener leaves it alone. */
  readonly #onControlKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).click();
  };

  #onFieldKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    // A newline and a confirmed candidate both belong to the field, so neither reaches a host.
    if (event.shiftKey || isComposingEnter(event, this.#composition)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    this.#submit();
  }

  #onCompositionStart(): void {
    this.#composition.composing = true;
  }

  #onCompositionEnd(event: CompositionEvent): void {
    this.#composition.composing = false;
    this.#composition.endedAt = event.timeStamp;
  }

  #onInput(): void {
    const field = this.#field;
    if (!field) return;
    this.draftEmpty = field.value.trim() === '';
    this.#fit(field);
  }

  #fit(field: HTMLTextAreaElement): void {
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }

  #submit(): void {
    const field = this.#field;
    if (!field || !this.model?.send(field.value)) return;
    field.value = '';
    this.draftEmpty = true;
    this.#fit(field);
  }

  #retry(): void {
    this.model?.retry();
    this.focus();
  }

  #openCitation(event: Event, turn: AssistantTurn, citation: AssistantCitation): void {
    const open = new CustomEvent('sub-assistant-source', { detail: { citation, turn: turn.id }, bubbles: true, composed: true, cancelable: true });
    if (!this.dispatchEvent(open)) event.preventDefault();
  }

  static css = css`
    :host {
      --_gap: var(--sub-assistant-gap, var(--wa-space-m, 1rem));
      --_small: var(--wa-space-xs, 0.5rem);
      --_quiet: var(--wa-color-text-quiet, GrayText);
      --_fill: var(--wa-color-neutral-fill-quiet, color-mix(in srgb, currentColor 8%, transparent));
      --_border: var(--wa-color-surface-border, color-mix(in srgb, currentColor 20%, transparent));
      --_control: var(--wa-form-control-border-color, color-mix(in srgb, currentColor 40%, transparent));
      --_brand: var(--wa-color-brand-fill-loud, LinkText);
      --_on-brand: var(--wa-color-brand-on-loud, Canvas);
      --_brand-quiet: var(--wa-color-brand-fill-quiet, color-mix(in srgb, LinkText 12%, transparent));
      --_on-brand-quiet: var(--wa-color-brand-on-quiet, LinkText);
      --_danger: var(--wa-color-danger-on-quiet, #b42318);
      --_radius: var(--wa-border-radius-m, 0.375rem);
      --_tiny: var(--wa-font-size-xs, 0.75rem);
      display: flex;
      flex-direction: column;
      position: relative;
      min-width: 0;
      min-height: 0;
      font-family: var(--wa-font-family-body, system-ui, sans-serif);
      font-size: var(--wa-font-size-s, 0.875rem);
      line-height: var(--wa-line-height-normal, 1.5);
      color: var(--wa-color-text-normal, CanvasText);
    }
    .vh {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
    .transcript {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: var(--_gap);
    }
    .transcript:focus-visible,
    button:focus-visible,
    a:focus-visible {
      outline: var(--wa-focus-ring, solid 0.1875rem Highlight);
      outline-offset: var(--wa-focus-ring-offset, 0.0625rem);
    }
    .turns {
      display: flex;
      flex-direction: column;
      gap: calc(var(--_gap) * 1.25);
    }
    .empty {
      color: var(--_quiet);
    }
    .turn {
      display: flex;
      flex-direction: column;
      gap: var(--_small);
    }
    .question {
      align-self: flex-end;
      max-width: 85%;
      padding: var(--_small) var(--wa-space-s, 0.75rem);
      border-radius: var(--wa-border-radius-l, 0.625rem);
      background: var(--_fill);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .answer {
      display: flex;
      gap: var(--_small);
      align-items: flex-start;
    }
    .ai {
      flex: none;
      margin-block-start: 0.15em;
      padding: 0 0.4em;
      border-radius: var(--wa-border-radius-s, 0.25rem);
      background: var(--_brand-quiet);
      color: var(--_on-brand-quiet);
      font-size: var(--_tiny);
      font-weight: var(--wa-font-weight-semibold, 600);
    }
    .text {
      margin: 0;
      min-width: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .trace,
    .provenance,
    .note,
    .working {
      font-size: var(--_tiny);
      color: var(--_quiet);
      overflow-wrap: anywhere;
    }
    .working {
      display: flex;
      align-items: center;
      gap: var(--_small);
    }
    .pulse {
      width: 0.5em;
      height: 0.5em;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.3;
      }
    }
    .sources {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wa-space-2xs, 0.25rem);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .source {
      display: inline-block;
      max-width: 16rem;
      padding: 0.1em 0.5em;
      border: var(--wa-border-width-s, 1px) solid var(--_border);
      border-radius: var(--_radius);
      background: none;
      color: inherit;
      font: inherit;
      font-size: var(--_tiny);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
    }
    .source:hover,
    .plain:hover {
      background: var(--_fill);
    }
    .failure {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--_small);
      color: var(--_danger);
      overflow-wrap: anywhere;
    }
    .plain,
    .loud {
      flex: none;
      padding: 0.3em 0.8em;
      border: var(--wa-border-width-s, 1px) solid var(--_control);
      border-radius: var(--_radius);
      background: none;
      color: var(--wa-color-text-normal, ButtonText);
      font: inherit;
      font-weight: var(--wa-font-weight-action, 500);
      cursor: pointer;
    }
    .loud {
      border-color: var(--_brand);
      background: var(--_brand);
      color: var(--_on-brand);
    }
    .loud[aria-disabled='true'] {
      opacity: 0.5;
      cursor: default;
    }
    .jump {
      position: absolute;
      inset-inline-end: var(--_gap);
      background: var(--wa-color-surface-default, Canvas);
      font-size: var(--_tiny);
      z-index: 1;
    }
    .jump-row {
      position: relative;
      height: 0;
    }
    .jump-row .jump {
      bottom: var(--_small);
    }
    .composer,
    .actions {
      display: flex;
      gap: var(--_small);
      align-items: flex-end;
      padding: var(--_small) var(--_gap) var(--_gap);
    }
    .actions {
      justify-content: flex-end;
    }
    textarea {
      flex: 1 1 auto;
      min-width: 0;
      max-height: 10rem;
      padding: 0.4em 0.7em;
      border: var(--wa-border-width-s, 1px) solid var(--_control);
      border-radius: var(--_radius);
      background: var(--wa-form-control-background-color, transparent);
      color: var(--wa-form-control-value-color, inherit);
      font: inherit;
      resize: none;
    }
    textarea::placeholder {
      color: var(--wa-form-control-placeholder-color, GrayText);
    }
    textarea:focus-visible {
      outline: var(--wa-focus-ring, solid 0.1875rem Highlight);
      outline-offset: var(--wa-focus-ring-offset, 0.0625rem);
    }
    @media (prefers-reduced-motion: reduce) {
      .pulse {
        animation: none;
      }
    }
    @media (forced-colors: active) {
      .question,
      .ai {
        border: 1px solid CanvasText;
      }
      .loud {
        forced-color-adjust: none;
        background: ButtonText;
        color: ButtonFace;
      }
    }
  `;

  render() {
    const snapshot = this.#snapshot;
    const turns = snapshot?.turns ?? [];
    const words = this.#words;
    const last = turns[turns.length - 1];
    return html`<section part="transcript" class="transcript" tabindex="0" aria-label=${this.label || words.conversation} @scroll=${this.#onScroll}>
        <div class="turns">
          ${turns.length === 0
            ? html`<div part="empty" class="empty"><slot name="empty"></slot></div>`
            : repeat(
                turns,
                (turn) => turn.id,
                (turn) => this.#turn(turn, turn === last, words),
              )}
        </div>
      </section>
      ${this.showJump
        ? html`<div class="jump-row">
            <button type="button" part="jump" class="plain jump" @click=${this.#jump} @keydown=${this.#onControlKey}>${words.jump}</button>
          </div>`
        : nothing}
      ${this.#composer(snapshot, words)}
      <div class="vh" role="status">${this.announcement}</div>`;
  }

  #turn(turn: AssistantTurn, last: boolean, words: AssistantLabels): TemplateResult {
    const blocks = blocksOf(turn.parts);
    const firstText = blocks.find((b) => b.kind === 'text');
    const retryable = last && (turn.status === 'failed' || turn.status === 'ended-early');
    return html`<article part="turn" class="turn">
      <div class="vh" role="heading" aria-level=${this.headingLevel}>${words.you}</div>
      <div part="question" class="question">${turn.question}</div>
      <div class="vh" role="heading" aria-level=${this.headingLevel}>${words.assistant}</div>
      ${repeat(
        blocks,
        (block) => block.id,
        (block) => (block.kind === 'text' ? this.#text(block.text, block === firstText, words) : this.#trace(block.parts, words)),
      )}
      ${turn.status === 'running' && !firstText
        ? html`<div part="working" class="working"><span class="pulse" aria-hidden="true"></span>${words.working}</div>`
        : nothing}
      ${turn.citations.length > 0
        ? html`<ul part="sources" class="sources" aria-label=${words.sources}>
            ${turn.citations.map((citation) => html`<li>${this.#citation(turn, citation)}</li>`)}
          </ul>`
        : nothing}
      ${turn.provenance ? html`<div part="provenance" class="provenance">${words.provenance(turn.provenance, this.#lang)}</div>` : nothing}
      ${this.#outcome(turn, retryable, words)}
    </article>`;
  }

  #text(text: string, marked: boolean, words: AssistantLabels): TemplateResult {
    return html`<div class="answer">
      ${marked ? html`<span part="ai-marker" class="ai">${words.aiMarker}</span>` : nothing}
      <p part="answer" class="text">${growingText(text)}</p>
    </div>`;
  }

  #trace(parts: Exclude<AssistantPart, { kind: 'text' }>[], words: AssistantLabels): TemplateResult {
    const said = parts.map((p) => (p.kind === 'tool' ? words.tool(p.tool, p.status) : p.text));
    return html`<div part="trace" class="trace">${said.join(' · ')}</div>`;
  }

  #citation(turn: AssistantTurn, citation: AssistantCitation): TemplateResult {
    const open = (event: Event) => this.#openCitation(event, turn, citation);
    return citation.url
      ? html`<a part="source" class="source" href=${citation.url} target="_blank" rel="noopener noreferrer" @click=${open} @keydown=${this.#onControlKey}>${citation.title}</a>`
      : html`<button type="button" part="source" class="source" @click=${open} @keydown=${this.#onControlKey}>${citation.title}</button>`;
  }

  #outcome(turn: AssistantTurn, retryable: boolean, words: AssistantLabels): TemplateResult | typeof nothing {
    const retry = retryable
      ? html`<button type="button" part="retry" class="plain" @click=${this.#retry} @keydown=${this.#onControlKey}>${words.retry}</button>`
      : nothing;
    if (turn.status === 'failed') return html`<div part="failure" class="failure"><span>${turn.failure ? words.failure(turn.failure) : ''}</span>${retry}</div>`;
    if (turn.status === 'ended-early') return html`<div part="failure" class="failure"><span>${words.endedEarly}</span>${retry}</div>`;
    const note =
      turn.status === 'stopped'
        ? words.stopped
        : turn.status === 'needs-approval'
          ? words.needsApproval
          : turn.status === 'budget'
            ? words.budgetOut
            : turn.budgetExhausted
              ? words.budgetLast
              : null;
    return note ? html`<div part="note" class="note">${note}</div>` : nothing;
  }

  #composer(snapshot: AssistantSnapshot | null, words: AssistantLabels): TemplateResult | typeof nothing {
    const stop = html`<button type="button" part="stop" class="plain" @click=${() => this.model?.stop()} @keydown=${this.#onControlKey}>${words.stop}</button>`;
    if (this.hideComposer) return snapshot?.canStop ? html`<div class="actions">${stop}</div>` : nothing;
    const blocked = this.draftEmpty || (snapshot?.running ?? false);
    return html`<form part="composer" class="composer" @submit=${(event: Event) => event.preventDefault()}>
      <textarea
        part="input"
        rows="1"
        aria-label=${words.input}
        placeholder=${this.placeholder}
        maxlength=${this.maxLength ?? nothing}
        @input=${this.#onInput}
        @keydown=${this.#onFieldKey}
        @compositionstart=${this.#onCompositionStart}
        @compositionend=${this.#onCompositionEnd}
      ></textarea>
      ${snapshot?.canStop
        ? stop
        : html`<button type="button" part="send" class="loud" aria-disabled=${blocked ? 'true' : 'false'} @click=${this.#submit} @keydown=${this.#onControlKey}>${words.send}</button>`}
    </form>`;
  }
}

if (!customElements.get('sub-assistant')) customElements.define('sub-assistant', SubAssistant);

declare global {
  interface HTMLElementTagNameMap {
    'sub-assistant': SubAssistant;
  }
}
