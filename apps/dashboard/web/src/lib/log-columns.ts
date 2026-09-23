export const LOG_COLUMNS = [
  'timestamp',
  'level',
  'message',
  'service',
  'trigger',
  'invocation',
  'entrypoint',
  'outcome',
  'cpuTimeMs',
  'wallTimeMs',
  'requestId',
  'invocationId',
] as const;
export type LogColumn = (typeof LOG_COLUMNS)[number];
export const DEFAULT_LOG_COLUMNS: LogColumn[] = ['timestamp', 'level', 'message', 'outcome', 'cpuTimeMs'];
export const LOG_COLUMN_LABELS: Record<LogColumn, string> = {
  timestamp: 'Time (UTC)',
  level: 'Level',
  message: 'Message',
  service: 'Service',
  trigger: 'Trigger',
  invocation: 'Invocation kind',
  entrypoint: 'Entrypoint',
  outcome: 'Outcome',
  cpuTimeMs: 'CPU',
  wallTimeMs: 'Wall time',
  requestId: 'Provider request ID',
  invocationId: 'Invocation ID',
};
export const LOG_COLUMNS_KEY = 'substrat.observability.log-columns.v1';
export function parseLogColumns(raw: string | null): LogColumn[] {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!Array.isArray(value)) return [...DEFAULT_LOG_COLUMNS];
    const known = [
      ...new Set(value.filter((v): v is LogColumn => typeof v === 'string' && LOG_COLUMNS.includes(v as LogColumn))),
    ];
    return known.length ? known : [...DEFAULT_LOG_COLUMNS];
  } catch {
    return [...DEFAULT_LOG_COLUMNS];
  }
}
export function moveColumn(columns: LogColumn[], key: LogColumn, direction: -1 | 1): LogColumn[] {
  const result = [...columns],
    index = result.indexOf(key),
    next = index + direction;
  if (index < 0 || next < 0 || next >= result.length) return result;
  [result[index], result[next]] = [result[next]!, result[index]!];
  return result;
}
