/**
 * A minimal `<substrat-assistant>`: enough to measure what a Lit element costs on the wire,
 * not a design. It renders the message list from the headless client's state, an input, a
 * Stop button, tool steps by name, an approval card, and the accessibility behaviour the
 * RFC asks for (a labelled log region, one polite announcement per completed turn, tool
 * prompts announced as their own events).
 */
import { LitElement, html, css } from 'lit';
import { connect } from './assistant-client.mjs';

export class SubstratAssistant extends LitElement {
  static properties = {
    endpoint: { type: String },
    thread: { type: String },
    _state: { state: true },
    _draft: { state: true },
    _announce: { state: true },
  };

  static styles = css`
    :host { display: block; font: var(--sa-font, 14px/1.5 system-ui); color: var(--sa-fg, #111); }
    ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .user { justify-self: end; background: var(--sa-accent, #2b5); color: #fff; padding: 6px 10px; border-radius: 12px; }
    .ai { background: var(--sa-bubble, #f2f2f2); padding: 6px 10px; border-radius: 12px; }
    .step { color: #666; font-size: 12px; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 8px; }
    form { display: flex; gap: 8px; margin-top: 8px; }
    input { flex: 1; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    @media (prefers-reduced-motion: no-preference) { .ai { transition: background 120ms; } }
  `;

  constructor() {
    super();
    this._state = { messages: [], phase: 'idle', approval: null };
    this._draft = '';
    this._announce = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this._client = connect(this.endpoint, this.thread, (state) => {
      const prev = this._state;
      this._state = state;
      if (prev.phase !== 'idle' && state.phase === 'idle') this._announce = 'Response complete';
      if (state.approval && !prev.approval) this._announce = `Approval needed: ${state.approval.preview}`;
    });
  }

  render() {
    const { messages, phase, approval } = this._state;
    return html`
      <ol role="log" aria-label="Conversation" aria-live="off">
        ${messages.map(
          (m) => html`<li class=${m.role}>${m.steps?.map((s) => html`<div class="step">${s}</div>`)}${m.text}</li>`,
        )}
      </ol>
      ${approval
        ? html`<div class="card" role="group" aria-label="Approval needed">
            <div>${approval.preview}</div>
            <button @click=${() => this._client.approve(approval, true)}>Approve</button>
            <button @click=${() => this._client.approve(approval, false)}>Cancel</button>
          </div>`
        : ''}
      <form @submit=${(e) => { e.preventDefault(); this._client.send(this._draft); this._draft = ''; }}>
        <input .value=${this._draft} @input=${(e) => (this._draft = e.target.value)} aria-label="Message" />
        ${phase === 'streaming'
          ? html`<button type="button" @click=${() => this._client.stop()}>Stop</button>`
          : html`<button>Send</button>`}
      </form>
      <div class="sr" role="status" aria-live="polite">${this._announce}</div>
    `;
  }
}

customElements.define('substrat-assistant', SubstratAssistant);
