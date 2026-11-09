import { readAssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';
import type { AssistantEvent, AssistantHistoryEntry, AssistantLabels, AssistantSource } from '@substrat-run/elements';
import { writtenAtLabel } from './explanations';

/**
 * Ask in the ⌘K overlay (#2283): the dashboard's route as the source `<sub-assistant>` reads.
 * Pure, so what the reader is told (which reads the answer came from, whether the budget ran
 * out, what went wrong) is asserted without drawing anything.
 *
 * Events are read with `readAssistantStreamEvent`, the protocol's forward-compatible reader: an
 * event this page does not know is skipped, not a crash, so a newer dashboard worker can add
 * one without breaking an older page.
 */

/** What the overlay calls to ask: the dashboard's `dashboard/ask` route, or the preview's stand-in. */
export type AskFn = (input: { messages: AssistantHistoryEntry[] }) => Promise<{ events: Array<Record<string, unknown>> }>;

/** A read's name as the reader says it: `list_team_audit` → "team audit", `finding_evidence` → "finding evidence". */
export function readName(tool: string): string {
  return tool.replace(/^(list|get)_/, '').replace(/_/g, ' ');
}

/**
 * What one read returned, in the reader's words: "Read members (3)", "Read team audit (20+)"
 * when the list was cut, "Could not read findings: not part of your role" for a refusal.
 */
export function lookLabel(tool: string, output: unknown): string {
  const name = readName(tool);
  // A bare list is a read's answer as much as a page is (`list_deployments` answers one).
  if (Array.isArray(output)) return `Read ${name} (${output.length})`;
  const out = (output ?? {}) as { entries?: unknown[]; items?: unknown[]; truncated?: boolean; refused?: unknown; error?: unknown };
  const keys = Object.keys(out).filter((k) => k !== 'truncated');
  // A refusal or a failure is the tool's whole answer — one field — never a record that happens
  // to carry an `error` of its own (a deployment's last failure, an install's status).
  if (keys.length === 1 && typeof out.refused === 'string') return `Could not read ${name}: not part of your role`;
  if (keys.length === 1 && typeof out.error === 'string') return `Could not read ${name}: ${out.error}`;
  const list = out.entries ?? out.items;
  return Array.isArray(list) ? `Read ${name} (${list.length}${out.truncated ? '+' : ''})` : `Read ${name}`;
}

/**
 * A read as a line in the reader's words, since a tool's name and output are the dashboard's to
 * say. A tool's input says nothing until it has answered, so it is not drawn at all.
 */
function inWords(event: AssistantEvent): AssistantEvent | null {
  if (event.t === 'tool-input') return null;
  if (event.t === 'tool-output') return { t: 'host-event', kind: 'read', text: lookLabel(event.tool, event.output) };
  if (event.t === 'tool-error') return { t: 'host-event', kind: 'read', text: `Could not read ${readName(event.tool)}` };
  return event;
}

/** The route, one question at a time: a whole-body POST, played into the element as events. */
export function askSource(ask: AskFn): AssistantSource {
  return {
    async *send({ text, history }) {
      const { events } = await ask({ messages: historyFor(history, text) });
      for (const raw of events) {
        const read = readAssistantStreamEvent(raw);
        const event = read.known ? inWords(read.event) : null;
        if (event) yield event;
      }
    },
  };
}

/** What Ask says that the element would say differently. */
export const ASK_LABELS: Partial<AssistantLabels> = {
  conversation: 'Ask',
  working: 'Reading…',
  budgetOut: 'You have used today’s AI answers; they reset at midnight UTC.',
  budgetLast: 'That was today’s last AI answer.',
  provenance: (p) => {
    const reads = p.sources ?? 0;
    return `Answered ${writtenAtLabel(p.producedAt)} from ${reads} ${reads === 1 ? 'read' : 'reads'}${p.model ? ` · model ${p.model.split('/').pop()}` : ''}`;
  },
};

/** The most turns sent back with a question: the route's bound, user and assistant together. */
export const ASK_HISTORY_MAX = 12;

/** The conversation to send with a new question, the newest kept when it is too long. */
export function historyFor(history: readonly AssistantHistoryEntry[], question: string): AssistantHistoryEntry[] {
  // An odd count, so the kept window still opens on a question: question, answer, …, question.
  return [...history, { role: 'user' as const, text: question }].slice(-(ASK_HISTORY_MAX - 1));
}

/** The preview's assistant (DEV_MOCK): two reads and an answer, after a moment, and nothing leaves the page. */
export function mockAsk(): AskFn {
  return async ({ messages }) => {
    await new Promise((r) => setTimeout(r, 700));
    const question = messages[messages.length - 1]!.text;
    const at = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [
      { t: 'user-message', text: question },
      { t: 'turn-start', v: 1 },
      { t: 'step-start', step: 'look-1' },
      { t: 'tool-input', callId: 'c1', tool: 'list_findings', input: { status: 'open' } },
      { t: 'tool-output', callId: 'c1', tool: 'list_findings', output: { available: true, entries: [{}, {}], nextCursor: null, cut: false } },
      { t: 'step-end', step: 'look-1' },
      { t: 'text-start', pid: 'answer' },
      {
        t: 'text-delta',
        pid: 'answer',
        delta: 'Two findings are open. The critical one is a conflict on helpdesk/assign-ticket, which began 41 seconds after v14 went live, so that deploy is the likely cause; it is on your app’s side.',
      },
      { t: 'text-end', pid: 'answer' },
      { t: 'data-provenance', producedAt: at, model: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', sources: 1 },
      { t: 'turn-finish', reason: 'done' },
    ];
    return { events: events.map((e, i) => ({ ...e, id: i + 1 })) };
  };
}
