export type UsageScalar = string | number | boolean | null | undefined;

/** The plane's lowerBound field is the truncation signal at this boundary. */
export function isExactUsageFigure(signals: {
  truncated: UsageScalar;
  reason: UsageScalar;
  coverage: UsageScalar;
  estimated: UsageScalar;
  complete?: boolean;
}): boolean {
  return signals.truncated === false
    && (signals.reason === null || signals.reason === undefined)
    && signals.coverage === 'complete'
    && signals.estimated === false
    && signals.complete !== false;
}
