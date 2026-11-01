import { describe, expect, it } from 'vitest';
import { parseTenantRequestQuery } from '../src/tenant-request-query.js';

const TENANT = '01J0000000000000000000000A';
const query = (params: Record<string, string>) => {
  const s = new URLSearchParams(params);
  return { one: (k: string) => s.get(k) ?? undefined, all: (k: string) => s.getAll(k) };
};

describe('parseTenantRequestQuery — the path facet (#2762)', () => {
  it('takes a route and refuses a called path, which could only match nothing', () => {
    const route = 'GET /api/codes/:c{[a-z]{2,3}}';
    expect(parseTenantRequestQuery(TENANT, query({ path: route })).where).toEqual({ path: [route] });
    expect(() => parseTenantRequestQuery(TENANT, query({ path: '/api/items/7' }))).toThrow(/path is a route/);
  });
});
