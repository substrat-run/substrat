import { describe, expect, it } from 'vitest';
import { paletteItems, ulidTime, type PaletteContext } from '../src/lib/palette';

/** #1921: what the ⌘K overlay offers for a query. */

const CTX: PaletteContext = {
  apps: [
    { scopeId: 'A1', name: 'Helpdesk', host: 'help.acme.run', status: 'active' },
    { scopeId: 'A2', name: 'Field Ops', host: null, status: 'active' },
  ],
  currentApp: null,
  models: {
    A1: { lifecycles: ['conversation'], entities: ['conversation', 'contact'] },
    A2: { lifecycles: ['workOrder'], entities: ['workOrder'] },
  },
};

const labels = (q: string, ctx = CTX) => paletteItems(q, ctx).map((i) => `${i.group}: ${i.label}`);

describe('paletteItems', () => {
  it('offers apps, their process maps, the pages and the actions, grouped in the design’s order', () => {
    const all = labels('');
    expect(all.slice(0, 4)).toEqual(['Apps: Helpdesk', 'Apps: Field Ops', 'Process maps: Conversation', 'Process maps: Work Order']);
    expect(all).toContain('Pages: Observability › Processes');
    expect(all.at(-1)).toBe('Actions: Add domain');
  });

  it('filters by any part of the row, and finds a process map by its app', () => {
    expect(labels('help')).toEqual(['Apps: Helpdesk', 'Process maps: Conversation']);
    expect(labels('work')).toEqual(['Process maps: Work Order']);
    expect(labels('logs')).toEqual(['Pages: Observability › Logs']);
  });

  it('puts the reader’s app first, and its own tabs among the pages', () => {
    const inFieldOps = paletteItems('', { ...CTX, currentApp: 'A2' });
    expect(inFieldOps[0]).toMatchObject({ group: 'Apps', label: 'Field Ops' });
    expect(inFieldOps.find((i) => i.group === 'Process maps')!.label).toBe('Work Order');
    expect(inFieldOps.find((i) => i.group === 'Pages')).toMatchObject({ label: 'Field Ops › Overview', go: { kind: 'path', path: '/apps/A2/overview' } });
  });

  it('opens a process map on that lifecycle', () => {
    expect(paletteItems('conversation', CTX).find((i) => i.group === 'Process maps')!.go).toEqual({
      kind: 'path',
      path: '/observability?app=A1&view=map&entity=conversation',
    });
  });

  it('reads a pasted id as a request and as a record of each entity, in the reader’s app, lifecycles first', () => {
    const id = '01J8ZQ4C7X0000000000000001';
    const items = paletteItems(` ${id.toLowerCase()} `, { ...CTX, currentApp: 'A1' }).filter((i) => i.group === 'Open by id');
    expect(items.map((i) => i.go.kind)).toEqual(['request', 'record', 'record']);
    expect(items[0]!.go).toEqual({ kind: 'request', scopeId: 'A1', invocationId: id, atMs: ulidTime(id) });
    expect(items[1]!.go).toMatchObject({ kind: 'record', entityType: 'conversation', entityId: id });
    expect(items[2]!.go).toMatchObject({ entityType: 'contact' });
  });

  it('offers nothing by id outside an app — it would not know where to look', () => {
    expect(paletteItems('01J8ZQ4C7X0000000000000001', CTX).filter((i) => i.group === 'Open by id')).toEqual([]);
  });

  it('opens a record named as entity:id, even when the id is not a ULID', () => {
    const items = paletteItems('contact:c-42', { ...CTX, currentApp: 'A1' });
    expect(items[0]!.go).toEqual({ kind: 'record', scopeId: 'A1', entityType: 'contact', entityId: 'c-42' });
    expect(paletteItems('invoice:c-42', { ...CTX, currentApp: 'A1' }).filter((i) => i.group === 'Open by id')).toEqual([]);
  });
});

describe('ulidTime', () => {
  it('reads the millisecond timestamp off the first ten characters', () => {
    expect(ulidTime('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(1469922850259);
    expect(ulidTime('not-a-ulid')).toBeNull();
  });
});
