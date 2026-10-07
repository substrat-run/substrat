import { describe, expect, it } from 'vitest';
import { permissionKey } from '@substrat-run/contracts';
import { walkGrantedEntities, type GrantWalkRow, type GrantWalkStore } from '../src/grant-scoped-read.js';

const permission = permissionKey.parse('item:read');
const row = (subject: string, object: string, revoked_at: string | null = null): GrantWalkRow => ({
  subject, object, expires_at: null, revoked_at,
});

function store(grants: GrantWalkRow[], edges: GrantWalkRow[]): GrantWalkStore {
  return {
    nextGrant: (subject, _relation, after) => grants
      .filter((g) => g.subject === subject && g.object > after)
      .sort((a, b) => a.object.localeCompare(b.object))[0],
    nextChild: (parent, after) => edges
      .filter((e) => e.object === parent && e.subject > after)
      .sort((a, b) => a.subject.localeCompare(b.subject))[0],
  };
}

async function collect(source: GrantWalkStore, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 200; pageNo++) {
    const page = await walkGrantedEntities(
      source, ['principal:alice'], permission, 'item', '2026-01-01T00:00:00Z',
      async () => true, { limit, cursor, workBudget: 8 },
    );
    ids.push(...page.ids);
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('walk did not end');
}

describe('grant-scoped depth-first walk', () => {
  it('terminates on cycles and includes both sides of a diamond once as a set', async () => {
    const source = store(
      [row('principal:alice', 'box:root')],
      [
        row('box:a', 'box:root'), row('box:b', 'box:root'),
        row('item:shared', 'box:a'), row('item:shared', 'box:b'),
        row('box:root', 'box:a'), // a stored cycle; ctx.link refuses creating new ones
      ],
    );
    expect(new Set(await collect(source, 1))).toEqual(new Set(['shared']));
  });

  it('returns a continuation at its work budget, then finishes a wide graph', async () => {
    const children = Array.from({ length: 12 }, (_, i) =>
      row(`item:${String(i).padStart(5, '0')}`, 'box:root'));
    const ids = await collect(store([row('principal:alice', 'box:root')], children), 100);
    expect(new Set(ids).size).toBe(children.length);
  });

  it('skips revoked roots and edges and rechecks a candidate before returning it', async () => {
    const source = store(
      [row('principal:alice', 'box:dead', '2026-01-01'), row('principal:alice', 'box:root')],
      [row('item:hidden', 'box:root', '2026-01-01'), row('item:refused', 'box:root'), row('item:visible', 'box:root')],
    );
    const page = await walkGrantedEntities(
      source, ['principal:alice'], permission, 'item', '2026-01-01T00:00:00Z',
      async (entity) => entity.entityId === 'visible',
    );
    expect(page).toEqual({ kind: 'ids', ids: ['visible'], nextCursor: null });
  });
});
