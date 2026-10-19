import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundScopesView, Deployment, DeploymentVersion } from '../src/lib/api';
import { actorOf, entryVia } from '../src/lib/audit-activity';
import { BoundScopes } from '../src/views/BoundScopes';
import { VersionRow } from '../src/views/Verticals';

const client = vi.hoisted(() => ({ listBoundScopes: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  teamApi: () => client,
}));

/**
 * #2427: an enum the control plane owns reaches the page as a string, and a lookup table written
 * as an object literal answers for `constructor` and `toString` as well as for its own keys. Each
 * lookup below is fed those names and must treat them as unknown, as it treats `frobnicate`.
 */

const PROTOTYPE_NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

describe('audit actors named like Object.prototype keys (#2427)', () => {
  it.each(PROTOTYPE_NAMES)('%s is an actor nothing here can name, not a throw', (id) => {
    expect(actorOf(id)).toMatchObject({ kind: 'unknown', initials: '?' });
    expect(entryVia({ actor: id, onBehalfOf: { principal: 'P1' } as never })).toBe(actorOf(id).name);
  });

  it('a fixed service id is still a job', () => {
    expect(actorOf('01JZ000000000000000000DASH')).toMatchObject({ kind: 'job', name: 'Dashboard', initials: 'DA' });
  });
});

describe('plane-owned pill vocabularies (#2427)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    client.listBoundScopes.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const version = (over: Partial<DeploymentVersion>): DeploymentVersion => ({
    id: 'V1',
    version: '1.0.0',
    admission: 'admitted',
    admissionNote: null,
    deploymentRef: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  });
  const dep = (channel: string): Deployment =>
    ({ slug: 'acme/courses', displaySlug: 'courses', name: 'Courses', source: 'cli', owned: true, versions: [], channels: [{ channel, versionId: 'V1' }] }) as unknown as Deployment;

  it.each(PROTOTYPE_NAMES)('a version whose admission is %s shows as named', async (admission) => {
    await act(async () => root.render(<VersionRow d={dep('prod')} v={version({ admission })} last busy={false} onPromote={() => {}} />));
    expect(container.textContent).toContain(admission);
  });

  it.each(PROTOTYPE_NAMES)('a channel named %s shows as named', async (channel) => {
    await act(async () => root.render(<VersionRow d={dep(channel)} v={version({})} last busy={false} onPromote={() => {}} />));
    expect(container.textContent).toContain(channel);
  });

  it.each(PROTOTYPE_NAMES)('a bound scope whose status is %s shows as named', async (status) => {
    const view: BoundScopesView = {
      live: 1,
      archived: 0,
      scopes: [{ id: 'S1', slug: 'hr', name: 'HR', status, fork: false, movable: true, verticalVersionId: 'V1', createdAt: '2026-10-01T00:00:00.000Z', hostnames: [] }],
    } as BoundScopesView;
    client.listBoundScopes.mockResolvedValue(view);
    await act(async () => root.render(<BoundScopes teamId="T1" d={dep('prod')} all={[dep('prod')]} onChanged={() => {}} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain(status);
  });
});
