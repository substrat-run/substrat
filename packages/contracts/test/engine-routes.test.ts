/**
 * `defineEngineRoutes` — proving the checks bite.
 *
 * Type-level constraints fail permissively: written the obvious way, every one
 * of these compiles clean and enforces nothing. The `@ts-expect-error` controls
 * are the only thing that tells the two apart.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEngineRoutes, defineEntities, defineOperations } from '../src/index.js';

const entities = defineEntities({
  order: { table: 'eng_orders', fields: z.object({ id: z.string(), status: z.string() }) },
});

const engineOps = defineOperations(entities, ['order:read', 'order:close'] as const)({
  'engine/get': {
    summary: 'One order',
    permission: 'order:read',
    input: z.object({ orderId: z.string() }),
    output: z.object({ id: z.string() }),
  },
  'engine/close': {
    summary: 'Close it',
    permission: 'order:close',
    input: z.object({ orderId: z.string() }),
    output: z.object({ id: z.string() }),
  },
});

describe('an operation the engine does not have', () => {
  it('throws when the module loads, naming what the engine does declare', () => {
    // Deliberately NOT a compile error: the constraint is self-referential in
    // the bindings object and TypeScript accepts an unknown key anyway. A
    // constraint that reads like a check and enforces nothing is worse than
    // none, so the check lives here instead — still long before a request.
    expect(() =>
      defineEngineRoutes(engineOps)({
        // @ts-expect-error not an operation of this engine — the runtime is what catches it
        'engine/gett': { method: 'GET', path: '/orders' },
      }),
    ).toThrow(/not an operation of this engine — it declares engine\/close, engine\/get/);
  });
});

describe('what it merges', () => {
  const routes = defineEngineRoutes(engineOps)({
    'engine/get': { method: 'GET', path: '/orders/{orderId}' },
  });

  it('keeps the engine’s declaration and adds the path', () => {
    expect(routes['engine/get'].summary).toBe('One order');
    expect(routes['engine/get'].input).toBe(engineOps['engine/get'].input);
    expect(routes['engine/get'].http).toEqual({ method: 'GET', path: '/orders/{orderId}' });
  });

  it('binds only what it was given', () => {
    expect(Object.keys(routes)).toEqual(['engine/get']);
  });
});

// --- a path variable the engine's input does not accept ---------------------
defineEngineRoutes(engineOps)({
  // @ts-expect-error the input has `orderId`, not `id`
  'engine/get': { method: 'GET', path: '/orders/{id}' },
});

// --- a path with no variables is fine ---------------------------------------
defineEngineRoutes(engineOps)({
  'engine/close': { method: 'POST', path: '/orders/close' },
});
