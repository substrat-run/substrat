/**
 * The dashboard's contracts have fallen behind the control plane's (#2170): a declared route
 * could not parse a value the plane decides, and answered `null` ("cannot show you this")
 * instead of failing. The person is served either way, so this is how an operator learns it
 * happened, in the dashboard worker's own log beside `dashboard.request-failed`.
 *
 * Same vocabulary rule as that line: what failed is named by the output FIELD and the issue
 * PATHS only, never by a value or a message. The plane's answer is free text this worker did
 * not write, and no pattern can promise it holds no token or personal data.
 */
export function logOutputDrift(field: string, issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): void {
  console.warn(
    JSON.stringify({
      event: 'dashboard.output-drift',
      field,
      paths: [...new Set(issues.map((i) => i.path.map(String).join('.')))].slice(0, 10),
    }),
  );
}
