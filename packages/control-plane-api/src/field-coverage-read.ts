import { tallyFieldCoverageByRate, type FieldCoverageScope } from './field-coverage-tally.js';

export interface FieldCoverageWindow { since: string; until: string }

/** One row is a count of sampled SERIALISATIONS, with its provenance beside the numbers. */
export interface ObservedFieldRow {
  field: string;
  present: number;
  empty: number;
  absent: number;
  /** Present or null; absent optional fields do not enter this denominator. */
  eligible: number;
  sampleRate: number | null;
  window: FieldCoverageWindow;
}

export interface FieldCoverageRead {
  tenantId: string;
  vertical: string;
  versionId: string | null;
  source: 'vertical-asserted';
  window: FieldCoverageWindow;
  /** Empty means the router armed no request in this window. */
  groups: Array<{
    sampleRate: number | null;
    armedRequests: number;
    operations: Array<{ operation: string; responses: number; fields: ObservedFieldRow[] }>;
    /** Zero present and zero null in an armed sample: a candidate, never a proof of no use. */
    notObservedReturned: Array<{ operation: string; field: string }>;
    refused: number;
  }>;
}

/** The only public read shape over the raw report: declared names, counts, and no request detail. */
export function readFieldCoverage(
  reports: Iterable<unknown>,
  routerLines: Iterable<unknown>,
  scope: FieldCoverageScope & { versionId?: string },
  window: FieldCoverageWindow,
): FieldCoverageRead {
  const groups = tallyFieldCoverageByRate(reports, routerLines, scope).map((group) => {
    const byOperation = new Map(group.operations.map((op) => [op.operation, op]));
    const declared = scope.declared ?? {};
    const operations = Object.entries(declared).map(([operation, fields]) => {
      const observed = byOperation.get(operation);
      const byField = new Map(observed?.fields.map((f) => [f.field, f]) ?? []);
      return {
        operation,
        responses: observed?.responses ?? 0,
        fields: fields.map((field): ObservedFieldRow => {
          const count = byField.get(field);
          const present = count?.present ?? 0;
          const empty = count?.empty ?? 0;
          return {
            field, present, empty, absent: count?.absent ?? 0,
            eligible: present + empty,
            sampleRate: group.sampleRate,
            window,
          };
        }),
      };
    });
    return {
      sampleRate: group.sampleRate,
      armedRequests: group.armedRequests,
      operations,
      notObservedReturned: operations.flatMap((op) =>
        op.responses > 0
          ? op.fields.filter((f) => f.eligible === 0).map((f) => ({ operation: op.operation, field: f.field }))
          : []),
      refused: group.refused,
    };
  });
  return {
    tenantId: scope.tenantId,
    vertical: scope.vertical,
    versionId: scope.versionId ?? null,
    source: 'vertical-asserted',
    window,
    groups,
  };
}
