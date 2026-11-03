/**
 * `defineOperations` refuses once, with every problem its checks find. It used to stop at the
 * first: a declaration with three problems in three checks reported one, so a builder agent
 * spent a repair pass per problem — and the third was one it had added fixing the first.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities } from '../src/model.js';
import { defineOperations } from '../src/operations.js';

const entities = defineEntities({
  thing: { table: 't_thing', fields: z.object({ id: z.string(), name: z.string() }) },
});
const define = defineOperations(entities, ['thing:read', 'thing:write'] as const);
const entry = z.object({ id: z.string(), name: z.string() });

/** Never reached: each case is about the refusal, and the declaration is cast to get there. */
const refusal = (operations: Record<string, unknown>): string => {
  try {
    define(operations as never);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('the declaration was admitted');
};

describe('the operation declaration checks', () => {
  it('report every problem in one refusal: two in one check, and one in each of two more', () => {
    const message = refusal({
      'thing/list': { summary: 's', permission: 'thing:read', output: z.array(entry) },
      'thing/search': { summary: 's', permission: 'thing:read', output: z.array(entry) },
      'thing/rename': {
        summary: 's',
        permission: 'thing:write',
        input: z.object({ id: z.string(), name: z.string() }),
        output: entry,
        http: { method: 'PATCH', path: '/things/{id}' },
      },
      'thing/sorted': { summary: 's', permission: 'thing:read', output: entry, paged: { sortKey: 'id' }, authored: 'own walk' },
    });

    expect(message).toMatch(/^model: 4 problems in the operation declarations/);
    expect(message).toMatch(/\n1\. model: 'thing\/list' returns a bare array/);
    expect(message).toMatch(/\n2\. model: 'thing\/search' returns a bare array.*\n  Remedy: as for 1\.\n/);
    expect(message.match(/declare the ENTRY as `output`/g)).toHaveLength(1);
    expect(message).toMatch(/\n3\. model: 'thing\/rename' routes as PATCH/);
    expect(message).toMatch(/\n4\. model: 'thing\/sorted' declares `authored`/);
  });

  it("says a sortKey page is hand-written already, and offers the derived page instead", () => {
    const message = refusal({
      'thing/sorted': { summary: 's', permission: 'thing:read', output: entry, paged: { sortKey: 'id' }, authored: 'own walk' },
    });

    expect(message).toMatch(/^model: 'thing\/sorted' declares `authored`, but nothing about it is derivable/);
    expect(message).toContain('A `paged: { sortKey }` page is composed by its handler, so it is hand-written by construction.');
    expect(message).toContain("`derive: 'list'`");
  });
});
