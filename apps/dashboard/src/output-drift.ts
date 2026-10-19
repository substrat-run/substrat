import { issuePathsOf } from '@substrat-run/vertical-host';

/**
 * The dashboard's contracts have fallen behind the control plane's (#2170): a declared route
 * could not parse a value the plane decides, and answered `null` ("cannot show you this")
 * instead of failing. The person is served either way, so this is how an operator learns it
 * happened, in the dashboard worker's own log beside `dashboard.request-failed`.
 *
 * Same vocabulary rule as that line: what failed is named by the output FIELD and the issue
 * PATHS only (`issuePathsOf`), never by a value or a message. The plane's answer is free text this
 * worker did not write, and no pattern can promise it holds no token or personal data.
 *
 * One line per field per parse, with `count` (#2401): a field in a list row fails once per row,
 * and a page of 500 findings is not 500 lines. A parse is synchronous, so the lines go out on the
 * microtask after it, before the answer does.
 */
export function logOutputDrift(field: string, issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): void {
  if (pending.size === 0) queueMicrotask(flushOutputDrift);
  const seen = pending.get(field) ?? { paths: [], count: 0 };
  seen.paths = [...new Set([...seen.paths, ...issuePathsOf(issues)])].slice(0, 10);
  seen.count += 1;
  pending.set(field, seen);
}

const pending = new Map<string, { paths: string[]; count: number }>();

function flushOutputDrift(): void {
  for (const [field, { paths, count }] of pending) {
    console.warn(JSON.stringify({ event: 'dashboard.output-drift', field, paths, count }));
  }
  pending.clear();
}
