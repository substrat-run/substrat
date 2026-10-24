import { readAssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';

/**
 * Ask in the ⌘K overlay (#2283): the assistant's stream protocol, folded into what one turn
 * shows. Pure, so what the reader is told (which reads the answer came from, whether the budget
 * ran out, what went wrong) is asserted without drawing anything.
 *
 * Events are read with `readAssistantStreamEvent`, the protocol's forward-compatible reader: an
 * event this page does not know is skipped, not a crash, so a newer dashboard worker can add
 * one without breaking an older page.
 */

/** One read the assistant made, as the turn lists it: "Looked at 12 findings". */
export interface AskLook {
  tool: string;
  label: string;
}

export interface AskTurn {
  question: string;
  looks: AskLook[];
  /** The answer's text; empty while there is none. */
  answer: string;
  provenance: { producedAt: string; model: string | null; sources: number } | null;
  /** The person's or the team's daily budget ran out: on this turn, or with it. */
  budgetExhausted: boolean;
  /** A turn that ended without an answer, in words for the person. */
  error: string | null;
}

/** What a tool output says, in the reader's words. Refusals are shown as such. */
export function lookLabel(tool: string, output: unknown): string {
  const out = (output ?? {}) as { findings?: unknown[]; apps?: unknown[]; refused?: string; notFound?: string };
  if (out.refused) return `Could not read ${tool === 'list_apps' ? 'apps' : 'findings'}: not part of your role`;
  if (tool === 'list_findings') return `Looked at ${out.findings?.length ?? 0} findings`;
  if (tool === 'finding_evidence') return out.notFound ? 'Looked for a finding that does not exist' : 'Read one finding’s evidence';
  if (tool === 'list_apps') return `Looked at ${out.apps?.length ?? 0} apps`;
  return `Used ${tool}`;
}

/** Fold one response's events into the turn they describe. */
export function foldTurn(raw: readonly unknown[]): AskTurn {
  const turn: AskTurn = { question: '', looks: [], answer: '', provenance: null, budgetExhausted: false, error: null };
  for (const r of raw) {
    const read = readAssistantStreamEvent(r);
    if (!read.known) continue;
    const e = read.event;
    switch (e.t) {
      case 'user-message':
        turn.question = e.text;
        break;
      case 'tool-output':
        turn.looks.push({ tool: e.tool, label: lookLabel(e.tool, e.output) });
        break;
      case 'tool-error':
        turn.looks.push({ tool: e.tool, label: `${e.tool} failed` });
        break;
      case 'text-delta':
        turn.answer += e.delta;
        break;
      case 'data-provenance':
        turn.provenance = { producedAt: e.producedAt, model: e.model ?? null, sources: e.sources ?? 0 };
        break;
      case 'budget-notice':
        if (e.exhausted) turn.budgetExhausted = true;
        break;
      case 'turn-finish':
        if (e.reason === 'budget') turn.error = 'You have used today’s AI answers; they reset at midnight UTC.';
        break;
      case 'turn-error':
        turn.error = e.message;
        break;
      default:
        break;
    }
  }
  return turn;
}

/** The most turns sent back with a question: the route's bound, user and assistant together. */
export const ASK_HISTORY_MAX = 12;

/**
 * The conversation to send with a new question: each answered turn as a question and its answer,
 * oldest first, the newest kept when it is too long. A turn with no answer is left out, so a
 * failed question is not repeated to the model as if it had been answered.
 */
export function historyFor(turns: readonly AskTurn[], question: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  const past = turns.filter((t) => t.answer).flatMap((t) => [
    { role: 'user' as const, text: t.question },
    { role: 'assistant' as const, text: t.answer },
  ]);
  // An odd count, so the kept window still opens on a question: question, answer, …, question.
  return [...past, { role: 'user' as const, text: question }].slice(-(ASK_HISTORY_MAX - 1));
}

/** The preview's assistant (DEV_MOCK): two reads and an answer, after a moment, and nothing leaves the page. */
export function mockAsk(): (input: { messages: Array<{ role: 'user' | 'assistant'; text: string }> }) => Promise<{ events: Array<Record<string, unknown>> }> {
  return async ({ messages }) => {
    await new Promise((r) => setTimeout(r, 700));
    const question = messages[messages.length - 1]!.text;
    const at = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [
      { t: 'user-message', text: question },
      { t: 'turn-start', v: 1 },
      { t: 'step-start', step: 'look-1' },
      { t: 'tool-input', callId: 'c1', tool: 'list_findings', input: { status: 'open' } },
      { t: 'tool-output', callId: 'c1', tool: 'list_findings', output: { findings: [{}, {}], more: false } },
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
