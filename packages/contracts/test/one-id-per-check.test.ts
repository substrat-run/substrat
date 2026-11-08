/**
 * An entity-narrowed check reads one id, so the input carries it once (#3017). A builder eval's
 * derived list checked the deal its path named (`dealId`) and filtered by the `deal_id` the query
 * named, so a rep allowed one deal read any other's history. `defineOperations` refuses a second
 * spelling of the checked id at load.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities } from '../src/model.js';
import { defineOperations } from '../src/operations.js';

const entities = defineEntities({
  deal: { table: 't_deal', fields: z.object({ id: z.string(), name: z.string() }) },
});
const define = defineOperations(entities, ['deal:read'] as const);
const ok = z.object({ ok: z.boolean() });
const onDeal = (idFrom: string) => ({ key: 'deal:read', entity: 'deal', idFrom });
const byType = { key: 'deal:read', entityFrom: 'entityType', idFrom: 'entityId' };
const typed = { entityType: z.enum(['deal']), entityId: z.string() };

/** One operation, cast past the types: each case is about what the load-time check says. */
const declare = (permission: object, input: z.ZodRawShape, http?: { method: string; path: string }) => () =>
  define({ 'crm/op': { summary: 's', permission, input: z.object(input), output: ok, ...(http ? { http } : {}) } } as never);

describe('an entity-narrowed check takes its id once (#3017)', () => {
  it.each([
    {
      case: "a spelling of `idFrom` (the eval's `deal_id` beside `dealId`), the path naming the id",
      run: declare(onDeal('dealId'), { dealId: z.string(), deal_id: z.string().optional() }, {
        method: 'GET',
        path: '/deals/{dealId}/history',
      }),
      refusal:
        "model: 'crm/op' checks the 'deal' named by `dealId`, and its input also takes `deal_id` — a second field naming the same id.",
      remedy: 'Remedy: take the id once, as `dealId`, which the path already names (`/deals/{dealId}/history`); drop `deal_id`.',
    },
    {
      case: '`<entity>Id` beside an `idFrom` of another name, on a route whose path does not name it',
      run: declare(onDeal('id'), { id: z.string(), DealId: z.string().optional() }, { method: 'GET', path: '/history' }),
      refusal: "model: 'crm/op' checks the 'deal' named by `id`, and its input also takes `DealId`",
      remedy: 'Remedy: take the id once, as `id`, named in the path as `{id}`; drop `DealId`.',
    },
    {
      case: 'a spelling of `idFrom` under `entityFrom`, with no route',
      run: declare(byType, { ...typed, 'entity-id': z.string().optional() }),
      refusal: "model: 'crm/op' checks the entity named by `entityId`, and its input also takes `entity-id`",
      remedy: 'Remedy: take the id once, as `entityId`; drop `entity-id`.',
    },
  ])('refuses $case', ({ run, refusal, remedy }) => {
    expect(run).toThrow(refusal);
    expect(run).toThrow(remedy);
  });

  it.each([
    // The nested-route shape: the check on the parent, `id` addressing a child. The name says
    // nothing about which entity it is, so it is not judged.
    { case: 'a bare `id` beside a different `idFrom`', run: declare(onDeal('dealId'), { dealId: z.string(), id: z.string() }) },
    { case: 'a second deal named for its role', run: declare(onDeal('dealId'), { dealId: z.string(), targetDealId: z.string() }) },
    // `entityFrom` names no one entity, so `dealId` is not a spelling of the checked id.
    { case: '`<entity>Id` under `entityFrom`', run: declare(byType, { ...typed, dealId: z.string().optional() }) },
  ])('admits $case', ({ run }) => {
    expect(run).not.toThrow();
  });
});
