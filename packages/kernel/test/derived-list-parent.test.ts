/**
 * A derived list narrowed to a parent pages that parent's rows, whatever else the input names.
 *
 * The check reads the parent's id from one field; the page's filters are keyed by column. A plan
 * with a second field over the link column (`dealId` and `deal_id`) let `GET /deals/D2/history?
 * deal_id=D1` pass the check on D2 and page D1's history. `defineOperations` now refuses such a
 * declaration, so this plan is written by hand: one built before that refusal can still carry it.
 */
import { describe, expect, it } from 'vitest';
import type { DerivationPlan } from '@substrat-run/contracts';
import { derivedHandler } from '../src/derived-handlers.js';
import type { OperationContext, PageParams } from '../src/scope-host.js';

const plan = {
  kind: 'list',
  entity: 'dealHistory',
  table: 'deal_history',
  primaryKey: 'id',
  columns: ['id', 'deal_id', 'created_at'],
  permission: { key: 'deal:read', entity: 'deal', idFrom: 'dealId' },
  filters: [
    { field: 'dealId', column: 'deal_id' },
    { field: 'deal_id', column: 'deal_id' },
  ],
  total: false,
  parent: { entity: 'deal', table: 'deals', primaryKey: 'id', idFrom: 'dealId', column: 'deal_id' },
} as const satisfies DerivationPlan;

describe('a derived list narrowed to a parent', () => {
  it("pages the checked parent's rows when a second field names another", async () => {
    const checked: unknown[] = [];
    const paged: PageParams[] = [];
    const ctx = {
      check: async (_key: unknown, entity: unknown) => {
        checked.push(entity);
        return { allowed: true };
      },
      sql: { query: () => [{ found: 1 }] },
      page: async (_entity: string, params: PageParams) => {
        paged.push(params);
        return { entries: [], nextCursor: null };
      },
    } as unknown as OperationContext;

    await derivedHandler(plan)(ctx, { dealId: 'D2', deal_id: 'D1' } as never);

    expect(checked).toEqual([{ entityType: 'deal', entityId: 'D2' }]);
    expect(paged[0]?.filters).toEqual({ deal_id: 'D2' });
  });
});
