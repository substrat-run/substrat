/**
 * The classifier decides what counts as covered, and a bug in it is invisible in
 * the worst way: it would drop an operation from the generated suite while every
 * remaining test went on passing. So it is tested directly, against a synthetic
 * operation set rather than a real vertical's — a fixture that says exactly one
 * thing per case.
 */
import { describe, expect, it } from 'vitest';
import { z } from '@substrat-run/contracts';
import { planEntityCheckCoverage } from '../src/entity-check-suite.js';

const ops = {
  'x/node-check': {
    permission: 'thing:read',
    input: z.object({ thingId: z.string() }),
  },
  'x/walks': {
    narrows: { reason: 'per-row', checks: ['thing:read'] },
    output: z.array(z.object({ id: z.string() })),
  },
  'x/by-id': {
    permission: { key: 'thing:manage', entity: 'thing', idFrom: 'thingId' },
    input: z.object({ thingId: z.string() }),
  },
  'x/by-id-with-optional': {
    permission: { key: 'thing:manage', entity: 'thing', idFrom: 'thingId' },
    input: z.object({ thingId: z.string(), note: z.string().optional() }),
  },
  'x/by-id-needs-input': {
    permission: { key: 'thing:manage', entity: 'thing', idFrom: 'thingId' },
    input: z.object({ thingId: z.string(), name: z.string().min(1) }),
  },
  'x/resolved': {
    permission: { key: 'thing:manage', entity: 'thing', resolved: 'the thing the part is on' },
    input: z.object({ partId: z.string() }),
  },
};

describe('what the kit will drive', () => {
  it('drives an entity check whose id is in the input', () => {
    const { covered } = planEntityCheckCoverage(ops);
    expect(covered.map((c) => c.name)).toContain('x/by-id');
    expect(covered.find((c) => c.name === 'x/by-id')).toMatchObject({
      key: 'thing:manage',
      entity: 'thing',
      idFrom: 'thingId',
    });
  });

  it('needs no sample input for an operation whose other fields are optional', () => {
    // The reason the schema is read rather than a fixture entry demanded for
    // every operation: ceremony that is not needed gets skipped, and a kit
    // people skip parts of is a kit that covers less than it says.
    expect(planEntityCheckCoverage(ops).covered.map((c) => c.name)).toContain(
      'x/by-id-with-optional',
    );
  });

  it('drives an operation once its required field is supplied', () => {
    const before = planEntityCheckCoverage(ops);
    expect(before.covered.map((c) => c.name)).not.toContain('x/by-id-needs-input');
    expect(before.uncovered['x/by-id-needs-input']).toMatch(/no sample input.*name/);

    const after = planEntityCheckCoverage(ops, { 'x/by-id-needs-input': { name: 'n' } });
    expect(after.covered.map((c) => c.name)).toContain('x/by-id-needs-input');
    expect(after.uncovered['x/by-id-needs-input']).toBeUndefined();
  });
});

describe('what the kit reports rather than hides', () => {
  it('reports a resolved check as uncovered, carrying the declared reason', () => {
    const { uncovered } = planEntityCheckCoverage(ops);
    expect(uncovered['x/resolved']).toContain('the thing the part is on');
  });

  it('names every uncovered operation and nothing else', () => {
    expect(Object.keys(planEntityCheckCoverage(ops).uncovered).sort()).toEqual([
      'x/by-id-needs-input',
      'x/resolved',
    ]);
  });
});

describe('what is not this kit’s subject at all', () => {
  it('leaves node checks and proof walks out of BOTH lists', () => {
    // Not covered, and not uncovered either: neither declares an entity check,
    // so neither has one to honour. Reporting them as gaps would bury the real
    // gaps in noise, which is its own way of hiding them.
    const { covered, uncovered } = planEntityCheckCoverage(ops);
    for (const name of ['x/node-check', 'x/walks']) {
      expect(covered.map((c) => c.name)).not.toContain(name);
      expect(uncovered[name]).toBeUndefined();
    }
  });

  it('treats a field it cannot introspect as required rather than assuming optional', () => {
    // Guessing "optional" is the answer that silently drops an operation.
    const odd = {
      'x/opaque': {
        permission: { key: 'thing:manage', entity: 'thing', idFrom: 'thingId' },
        input: { shape: { thingId: z.string(), weird: {} } },
      },
    };
    expect(planEntityCheckCoverage(odd).uncovered['x/opaque']).toMatch(/weird/);
  });
});
