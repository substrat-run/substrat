// tsx --test tools/problem-codes-emit.test.mts
/**
 * Fixtures for `problem-codes-emit.mts` (#113): the two refusals a page cannot be trusted
 * without. A code dropped from DOCUMENTED_ERROR_CODES with no note would publish "Documented on
 * every operation" for a code that is not, and a page naming no code would stay served at a
 * `type` URI no problem document carries.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driftReport, pageDrift, registryFaults, renderPages, type Registry } from './problem-codes-emit.mts';

const agreeing: Registry = {
  codes: ['not_found', 'precondition_failed'],
  guidance: { not_found: {}, precondition_failed: { openapi: 'Only on the operations that accept `If-Match`.' } },
  wire: ['type', 'code'],
  members: { type: 'the type', code: 'the code' },
  documented: ['not_found'],
  typeBase: 'https://substrat.net/errors',
};

test('a code not documented on every operation must say where it is, and a stray page is red', () => {
  assert.deepEqual(registryFaults(agreeing), []);
  const faults = registryFaults({ ...agreeing, documented: [] });
  assert.equal(faults.length, 1);
  assert.match(faults[0]!, /^not_found: .*is not documented on every operation and says nowhere where it is/);

  const emitted = renderPages();
  const read = (f: string): string => emitted.get(f) ?? '';
  assert.equal(driftReport(pageDrift(emitted, [...emitted.keys()], read)), undefined);
  const drift = pageDrift(emitted, [...emitted.keys(), 'stray.md'], read);
  assert.deepEqual(drift, { drifted: [], stale: ['stray.md'] });
  assert.match(driftReport(drift) ?? '', /apps\/docs\/errors\/stray\.md: names no code in the taxonomy/);
});
