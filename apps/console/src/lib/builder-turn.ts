import type { BuilderTurn } from '@substrat-run/contracts';
import type { AssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';

/**
 * One line of a builder turn as the console shows it. The record keeps the
 * model's prose as text deltas and everything the studio did as host events;
 * this folds the deltas back into paragraphs and lifts the one thing a reader
 * opens a turn for, a gate's output, out of the event it rides in.
 */
export type TimelineItem =
  | { kind: 'message'; id: number; text: string }
  | { kind: 'prose'; id: number; text: string }
  | { kind: 'host'; id: number; event: string; text: string; output?: string }
  | { kind: 'end'; id: number; text: string; failed: boolean };

/** What a turn's metrics say at a glance; empty for a turn from before they were kept. */
export function metricsLine({ metrics, inputTokens }: Pick<BuilderTurn, 'metrics' | 'inputTokens'>): string[] {
  if (!metrics) return [];
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  const toolCalls = Object.values(metrics.tools);
  const failed = toolCalls.reduce((n, t) => n + t.errors, 0);
  return [
    ...(metrics.resolvedModel ? [`ran ${metrics.resolvedModel}`] : []),
    ...(metrics.skills ? [`skills ${metrics.skills}`] : []),
    `${metrics.passes} passes, ${metrics.steps} steps`,
    `${seconds(metrics.generatorMs)} model, ${seconds(metrics.gateMs)} gates`,
    ...(inputTokens ? [`${Math.round((100 * metrics.cachedInputTokens) / inputTokens)}% cached`] : []),
    `${toolCalls.reduce((n, t) => n + t.calls, 0)} tool calls${failed ? `, ${failed} failed` : ''}`,
    `${metrics.filesWritten} files written`,
  ];
}

/** The output a check event carries, when its gate did not pass. */
function gateOutput(event: string, data: unknown): string | undefined {
  if (event !== 'check' || typeof data !== 'object' || data === null) return undefined;
  const result = (data as { result?: { status?: unknown; output?: unknown } }).result;
  if (result?.status !== 'failed' && result?.status !== 'blocked') return undefined;
  return typeof result.output === 'string' && result.output.trim() ? result.output : undefined;
}

export function timelineOf(events: readonly AssistantStreamEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const prose = new Map<string, { kind: 'prose'; id: number; text: string }>();
  for (const e of events) {
    switch (e.t) {
      case 'user-message':
        items.push({ kind: 'message', id: e.id, text: e.text });
        break;
      case 'text-start': {
        const item = { kind: 'prose' as const, id: e.id, text: '' };
        prose.set(e.pid, item);
        items.push(item);
        break;
      }
      case 'text-delta': {
        const item = prose.get(e.pid);
        if (item) item.text += e.delta;
        break;
      }
      case 'host-event': {
        const output = gateOutput(e.kind, e.data);
        items.push({ kind: 'host', id: e.id, event: e.kind, text: e.text, ...(output ? { output } : {}) });
        break;
      }
      case 'turn-finish':
        items.push({ kind: 'end', id: e.id, text: `finished · ${e.reason}`, failed: false });
        break;
      case 'turn-error':
        items.push({ kind: 'end', id: e.id, text: `${e.code} · ${e.message}`, failed: true });
        break;
      default:
        break;
    }
  }
  return items;
}
