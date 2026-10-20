import { describe, expect, it } from 'vitest';
import { built, pushed, vertical } from './push-harness.js';

describe.runIf(built)('push carries its loaded module permission declarations (#2446)', () => {
  it('ships each module beside the registry derived from it', () => {
    const manifest = pushed(vertical([{ id: '@acme/engine-work' }, { id: 'helpdesk' }]));
    expect(manifest.modules).toEqual([
      { id: '@acme/engine-work', permissions: [{ key: 'engine-work:read', description: 'Read' }] },
      { id: 'helpdesk', permissions: [{ key: 'helpdesk:read', description: 'Read' }] },
    ]);
    expect(manifest.registry.permissions.map(({ key, declaredBy }) => ({ key, declaredBy }))).toEqual([
      { key: 'engine-work:read', declaredBy: ['@acme/engine-work'] },
      { key: 'helpdesk:read', declaredBy: ['helpdesk'] },
    ]);
  });
});
