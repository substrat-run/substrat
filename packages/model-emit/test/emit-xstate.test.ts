/**
 * #844 — the lifecycle rendered as an XState v5 machine.
 *
 * The assertions are exact objects for the reason `emit-sql.test.ts` gives about
 * exact strings: this output is read by tools that are not this repo, so "looks
 * about right" is not a property anything downstream can rely on.
 */
import { describe, expect, it } from 'vitest';
import { defineEntities, defineLifecycles, defineOperations, emitLifecycles } from '@substrat-run/contracts';
import { z } from 'zod';
import { emitXState } from '../src/index.js';

const entities = defineEntities({
  order: {
    table: 'shop_order',
    fields: z.object({ id: z.string(), status: z.enum(['planned', 'active', 'done']) }),
  },
});
// Written out rather than shared through a `const`: a hoisted object literal
// widens `permission` to `string`, and the operation shape is checked against
// the declared key union.
const io = { input: z.object({ id: z.string() }), output: z.object({}) };
const operations = defineOperations(
  entities,
  ['order:manage'] as const,
)({
  'shop/start': { summary: 'Start', permission: 'order:manage', ...io },
  'shop/finish': { summary: 'Finish', permission: 'order:manage', ...io },
  'shop/note': { summary: 'Note', permission: 'order:manage', ...io },
});

const lifecycle = emitLifecycles(
  defineLifecycles(
    entities,
    operations,
  )({
    order: {
      field: 'status',
      initial: 'planned',
      states: {
        planned: { on: { 'shop/start': 'active' } },
        active: { on: { 'shop/finish': 'done' }, allow: ['shop/note'], extensible: true },
        done: { terminal: true },
      },
    },
  }),
).order!;

describe('emitXState', () => {
  it('renders states, edges and the final state', () => {
    expect(emitXState('order', lifecycle)).toEqual({
      id: 'order',
      initial: 'planned',
      states: {
        active: { on: { 'shop/finish': 'done' }, meta: { allow: ['shop/note'] } },
        done: { type: 'final' },
        planned: { on: { 'shop/start': 'active' } },
      },
    });
  });

  it('keeps the operation id as the event name, losslessly', () => {
    expect(Object.keys(emitXState('order', lifecycle).states.planned!.on!)).toEqual(['shop/start']);
  });

  /**
   * The join K-38 makes possible: the guard is wired once, in the manifest,
   * against an operation — and every edge naming that operation inherits it.
   */
  it('joins a manifest guard onto the edge by operation id', () => {
    const machine = emitXState('order', lifecycle, {
      guards: [{ before: 'shop/finish', predicate: 'protocol/all-signed' }],
    });
    expect(machine.states.active!.on!['shop/finish']).toEqual({
      target: 'done',
      guard: 'protocol/all-signed',
    });
  });

  it('never renders a precondition as a self-transition', () => {
    const machine = emitXState('order', lifecycle);
    expect(machine.states.active!.on!['shop/note']).toBeUndefined();
    expect(machine.states.active!.meta).toEqual({ allow: ['shop/note'] });
  });
});
