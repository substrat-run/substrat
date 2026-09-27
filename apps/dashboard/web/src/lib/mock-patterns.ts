import type { LogPatterns, ObservabilityLogEvent } from './api';

/**
 * DEV_MOCK fixtures for the Logs › Patterns mode (#1747). Preview-only — nothing outside
 * `VITE_DEV_MOCK` reads this file. A handful of ticket0-shaped templates with a fixed
 * distribution, bucketed over whatever window the page asks about, and the lines one
 * pattern opens onto, so a click in the preview lands on rows.
 */

/** [template, lines per hour, level, a sample field set, the operation that writes it] */
const TEMPLATES: [string, number, 'debug' | 'info' | 'warn' | 'error', Record<string, string>, string][] = [
  ['reply to {ticketId} sent by {agent}', 120, 'info', { ticketId: 'T-4821', agent: 'sara' }, 'ticket0/reply'],
  ['ticket {ticketId} assigned to {team}', 44, 'info', { ticketId: 'T-4822', team: 'billing' }, 'ticket0/assign'],
  ['assignment of {ticketId} refused: {reason}', 12, 'warn', { ticketId: 'T-4830', reason: 'assignee not in team' }, 'ticket0/assign'],
  ['inbound mail from {domain} not ingested: {reason}', 6, 'warn', { domain: 'example.org', reason: 'no desk address' }, 'ticket0/ingest-mail'],
  ['assistant turn for {ticketId} took {ms} ms', 30, 'debug', { ticketId: 'T-4811', ms: '2140' }, 'ticket0/assistant-answer'],
  ['relay could not send {messageId}: {error}', 2, 'error', { messageId: 'M-991', error: 'provider timeout' }, 'ticket0/relay'],
];

export function mockLogPatterns(window: { from: number; to: number }, buckets: number): LogPatterns {
  const hours = (window.to - window.from) / 3_600_000;
  const bucketMs = Math.max(1000, Math.round((window.to - window.from) / buckets));
  const rows = TEMPLATES.map(([template, perHour, level]) => ({
    template,
    count: Math.max(1, Math.round(perHour * hours)),
    level,
  }));
  const total = rows.reduce((n, r) => n + r.count, 0);
  return {
    total,
    bucketMs,
    truncated: false,
    estimated: false,
    patterns: rows
      .map((r, i) => ({
        template: r.template,
        count: r.count,
        share: r.count / total,
        levels: { debug: 0, info: 0, warn: 0, error: 0, [r.level]: r.count },
        dominant: r.level,
        // A deterministic wobble, and the refused assignments only in the last third.
        buckets: Array.from({ length: buckets }, (_, b) => ({
          start: new Date(window.from + b * bucketMs).toISOString(),
          count:
            i === 2 && b < (buckets * 2) / 3
              ? 0
              : Math.max(0, Math.round((r.count / buckets) * (1 + 0.6 * Math.sin(b * 0.7 + i)))),
        })).filter((s) => s.count > 0),
      }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * The lines one pattern opens onto — rendered from its sample fields, and placed inside the
 * window the page is showing, newest last-bucket first, so the preview never lists a line
 * the window could not contain.
 */
export function mockPatternLines(template: string, window: { from: number; to: number }): ObservabilityLogEvent[] {
  const found = TEMPLATES.find((t) => t[0] === template);
  if (!found) return [];
  const [, , level, fields, operation] = found;
  const message = template.replace(/\{(\w+)\}/g, (_, k: string) => fields[k] ?? `{${k}}`);
  const step = Math.max(1000, Math.floor((window.to - window.from) / 9));
  return Array.from({ length: 8 }, (_, i) => ({
    timestamp: window.to - (i + 1) * step,
    level,
    message,
    service: 'ticket0',
    outcome: 'ok',
    trigger: operation,
    invocation: 'fetch',
    entrypoint: null,
    requestId: `req-${i}`,
    invocationId: `01J8ZP${String(i).padStart(20, '0')}`,
    cpuTimeMs: null,
    wallTimeMs: null,
    raw: { source: { substrat: 'log', template, message, level } },
  }));
}
