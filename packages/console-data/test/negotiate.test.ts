import { describe, expect, it } from 'vitest';
import { CAPABILITIES, MISSING_CAPABILITY_TEXT, negotiate, REQUEST_FIELDS, VIEW_NEEDS, type SourceCapabilities } from '../src/index.js';

const everything: SourceCapabilities = {
  tail: true,
  rawPayloads: true,
  exactFacetCounts: true,
  traceSteps: true,
  model: true,
  permissions: true,
  requestFields: REQUEST_FIELDS,
};
const headOnly: SourceCapabilities = {
  tail: false,
  rawPayloads: false,
  exactFacetCounts: false,
  traceSteps: false,
  model: true,
  permissions: true,
  requestFields: REQUEST_FIELDS.filter((f) => f !== 'principal'),
};

describe('negotiate', () => {
  it('a source with everything serves every view in full', () => {
    for (const needs of Object.values(VIEW_NEEDS)) {
      expect(negotiate(everything, needs)).toEqual({ available: true, degraded: false, missing: [], lost: [], missingFields: [] });
    }
  });

  it('a head-only source degrades the request list and refuses the waterfall, saying why', () => {
    expect(negotiate(headOnly, VIEW_NEEDS.requests)).toMatchObject({ available: true, degraded: true, lost: ['exactFacetCounts'] });
    expect(negotiate(headOnly, VIEW_NEEDS.waterfall)).toMatchObject({
      available: false,
      degraded: false,
      missing: ['traceSteps'],
      lost: ['rawPayloads'],
      missingFields: ['principal'],
    });
    expect(negotiate(headOnly, VIEW_NEEDS.liveTail)).toMatchObject({ available: false, missing: ['tail'] });
    expect(negotiate(headOnly, VIEW_NEEDS.processMap)).toMatchObject({ available: true, degraded: false });
  });

  it('a missing shown field alone degrades a view', () => {
    expect(negotiate({ ...everything, requestFields: ['invocationId'] }, { fields: ['invocationId', 'operation'] })).toEqual({
      available: true,
      degraded: true,
      missing: [],
      lost: [],
      missingFields: ['operation'],
    });
  });

  it('every capability has the text a view shows when it is missing', () => {
    for (const c of CAPABILITIES) expect(MISSING_CAPABILITY_TEXT[c]).toMatch(/\S/);
  });
});
