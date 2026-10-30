import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AppRow, type PermissionRegistry } from '../src/lib/api';
import { PromoteDialog } from '../src/components/PromoteDialog';
import { diffRegistries, RESERVED_KEY_MARK } from '../src/lib/registry-diff';
import { permissionDiffItems } from '../src/lib/release-ledger';
import { AppPermissions } from '../src/views/AppDetail';

/**
 * #2430: every dashboard reader of the version-to-version diff shows what a reservation does — a key
 * that arrives reserved, a key whose reservation moved, a role whose holder moved, and a role that
 * arrives held by a system principal — so a reviewer never reads a system-held role holding a
 * reserved key as the person's role a push refuses. One pair of registries carries all four.
 */
const row = (key: string, holder?: 'system') => ({ key, description: `the ${key} key`, declaredBy: ['@acme/engine'], ...(holder ? { holder } : {}) });
const from: PermissionRegistry = {
  permissions: [row('a:use'), row('a:run')],
  roles: [
    { key: 'member', permissions: ['a:use'], source: 'vertical' },
    { key: 'driver', permissions: ['a:run'], source: 'vertical' },
  ],
  entityGrants: [],
};
const to: PermissionRegistry = {
  permissions: [row('a:use'), row('a:run', 'system'), row('a:new', 'system')],
  roles: [
    { key: 'member', permissions: ['a:use'], source: 'vertical' },
    { key: 'driver', permissions: ['a:run'], source: 'vertical', holder: 'system' },
    { key: 'host', permissions: ['a:new'], source: 'vertical', holder: 'system' },
  ],
  entityGrants: [],
};
const MOVED_RESERVATION = "a:run is now reserved to a system principal: no person's role or grant shape may hold it";
const MOVED_HOLDER = 'now held by a system principal (holder: system), no longer a role a person can hold';
const NEW_SYSTEM_ROLE = 'held by a system principal (holder: system), not a role a person can hold';

describe('the Deployments ledger (#2430)', () => {
  it('marks the key that arrives reserved, the moved reservation, the moved holder and the new system-held role', () => {
    const items = permissionDiffItems(diffRegistries(from, to), from, to);
    expect(items).toContainEqual({ kind: 'added', name: 'a:new', note: `the a:new key (${RESERVED_KEY_MARK})` });
    expect(items).toContainEqual({ kind: 'changed', name: 'a:run', note: MOVED_RESERVATION });
    expect(items).toContainEqual({ kind: 'changed', name: 'role driver', note: MOVED_HOLDER });
    expect(items).toContainEqual({ kind: 'added', name: 'role host', note: `holds a:new; ${NEW_SYSTEM_ROLE}` });
    // A person's role that did not change is not a row, and an unmarked added key carries no mark.
    expect(items.find((i) => i.name === 'role member')).toBeUndefined();
  });
});

describe('the promote dialog and the Permissions tab (#2430)', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  const shows = (text: string) => expect(container.textContent).toContain(text);

  it('the promote dialog shows all four', async () => {
    await act(async () =>
      root.render(
        <PromoteDialog
          slug="acme/helpdesk"
          servingLabel="0.2.0"
          incomingLabel="0.3.0"
          checkpoint={{ permission: { kind: 'diff', diff: diffRegistries(from, to), from, to }, migration: null, acknowledged: {} }}
          onAnswer={() => {}}
        />,
      ),
    );
    shows(`the a:new key (${RESERVED_KEY_MARK})`);
    shows(MOVED_RESERVATION);
    shows(MOVED_HOLDER);
    shows(NEW_SYSTEM_ROLE);
    // The moved holder is said as one; the new system-held role is a new role, not a holder change.
    shows('role holder changed');
    expect(container.textContent?.match(/role holder changed/g)).toHaveLength(1);
  });

  it('the Permissions tab shows all four for an available update', async () => {
    vi.spyOn(api, 'appPermissions').mockResolvedValue({
      running: { versionId: 'V2', version: '0.2.0', registry: from },
      update: { versionId: 'V3', version: '0.3.0', registry: to },
    });
    const app = { app_scope_id: 'S1', name: 'Acme HR', vertical_slug: 'acme/helpdesk', status: 'active' } as AppRow;
    await act(async () => root.render(<AppPermissions teamId="T1" app={app} />));
    // The mark sits beside the added key itself, not only inside the moved reservation's sentence.
    shows(`a:new${RESERVED_KEY_MARK}`);
    shows(MOVED_RESERVATION);
    shows(MOVED_HOLDER);
    shows(NEW_SYSTEM_ROLE);
    expect(container.textContent?.match(/role holder changed/g)).toHaveLength(1);
  });
});
