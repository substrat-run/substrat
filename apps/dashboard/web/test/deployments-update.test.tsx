import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AppDeployments, type AppRow } from '../src/lib/api';
import { MOCK_APP_DEPLOYMENTS } from '../src/lib/mock-deployments';
import { updatePlacement } from '../src/lib/release-ledger';
import { Deployments } from '../src/views/AppDetail';

/**
 * The Update action is the one action on the Deployments tab (#1767). It moved from the
 * Running bar into the comparison card's header, so where it renders — and that it
 * renders exactly once — is held here against the whole tab, not only the card.
 */

const V300 = '01J2Q8Z3V9K4W7X2M5N6P7V300';
const V400 = '01J2Q8Z3V9K4W7X2M5N6P7V400';
const app = { app_scope_id: 'S1', name: 'Acme HR', vertical_slug: 'acme/helpdesk', status: 'active' } as AppRow;

describe('updatePlacement', () => {
  it('puts Update in the card, the Running bar when prod is off the page, or nowhere', () => {
    expect(updatePlacement(true, true)).toBe('card');
    expect(updatePlacement(true, false)).toBe('bar');
    expect(updatePlacement(false, true)).toBeNull();
    expect(updatePlacement(false, false)).toBeNull();
  });
});

describe('Deployments tab — the Update action', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    // Every secondary read fails: the Update action must not depend on any of them.
    const refuse = () => Promise.reject(new Error('not served'));
    vi.spyOn(api, 'appBookmarks').mockImplementation(refuse);
    vi.spyOn(api, 'listReleases').mockImplementation(refuse);
    vi.spyOn(api, 'channelHistory').mockImplementation(refuse);
    vi.spyOn(api, 'releaseComparison').mockImplementation(refuse);
    vi.spyOn(api, 'appPermissions').mockImplementation(refuse);
    vi.spyOn(api, 'appModel').mockImplementation(refuse);
    vi.spyOn(api, 'appMigrations').mockImplementation(refuse);
    vi.spyOn(api, 'promoteReview').mockImplementation(refuse);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const render = async (dep: AppDeployments) => {
    vi.spyOn(api, 'appDeployments').mockResolvedValue(dep);
    await act(async () => root.render(<Deployments app={app} />));
  };
  const updateButtons = () => [...container.querySelectorAll('button')].filter((b) => /^Update (this app|to latest)$/.test(b.textContent ?? ''));
  const comparisonHeader = () => [...container.querySelectorAll('span')].find((s) => s.textContent === 'Release comparison')!.parentElement!;
  const runningBar = () => [...container.querySelectorAll('div')].find((d) => d.firstElementChild?.textContent === 'Running')!;

  it('(a) update with prod loaded: one button, in the comparison header', async () => {
    await render({ ...MOCK_APP_DEPLOYMENTS, versions: MOCK_APP_DEPLOYMENTS.versions.filter((v) => v.id !== V400) });
    expect(updateButtons()).toHaveLength(1);
    expect(updateButtons()[0]!.textContent).toBe('Update this app');
    expect(comparisonHeader().contains(updateButtons()[0]!)).toBe(true);
  });

  it('(b) update with prod beyond the loaded page: the button is in the Running bar', async () => {
    await render({ ...MOCK_APP_DEPLOYMENTS, versions: MOCK_APP_DEPLOYMENTS.versions.filter((v) => v.id !== V300 && v.id !== V400) });
    expect(updateButtons()).toHaveLength(1);
    expect(updateButtons()[0]!.textContent).toBe('Update to latest');
    expect(runningBar().contains(updateButtons()[0]!)).toBe(true);
    // Not knowing what prod is must never read as being current.
    expect(container.textContent).not.toContain('Running the latest version');
    expect(comparisonHeader().parentElement!.textContent).toContain('An update is available');
  });

  it('(c) no update: no Update button anywhere', async () => {
    await render({ ...MOCK_APP_DEPLOYMENTS, versions: MOCK_APP_DEPLOYMENTS.versions.filter((v) => v.id !== V400), boundVersionId: V300 });
    expect(updateButtons()).toHaveLength(0);
    expect(container.textContent).toContain('Running the latest version — nothing to update to.');
  });

  it('(d) an admitted push waiting for prod: the promotion is offered, no Update', async () => {
    // Running = prod = 0.3.0, while 0.4.0-beta.7 is admitted and not in prod.
    await render({ ...MOCK_APP_DEPLOYMENTS, boundVersionId: V300 });
    expect(updateButtons()).toHaveLength(0);
    const header = comparisonHeader();
    expect(header.textContent).toContain('0.4.0-beta.7');
    expect(header.textContent).toContain('not live');
    expect([...header.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Promote on Verticals']);
    // A vertical the team does not promote itself says who does.
    act(() => root.unmount());
    root = createRoot(container);
    await render({ ...MOCK_APP_DEPLOYMENTS, boundVersionId: V300, listed: true });
    expect(comparisonHeader().textContent).toContain('the Substrat team promotes it to prod');
  });

  describe('the newest admitted push is not on the first page', () => {
    const pending = { ...MOCK_APP_DEPLOYMENTS.versions[0]!, id: 'PENDING1', version: '0.5.0-pending', admission: 'pending' as const };
    const page1: AppDeployments = { ...MOCK_APP_DEPLOYMENTS, boundVersionId: V300, versions: [pending], nextCursor: 'c1' };
    const page2: AppDeployments = { ...MOCK_APP_DEPLOYMENTS, boundVersionId: V300, nextCursor: null };

    it('walks older pages until an admitted version is found, then offers the promotion', async () => {
      const spy = vi.spyOn(api, 'appDeployments').mockImplementation((_s, o) => Promise.resolve(o?.cursor === 'c1' ? page2 : page1));
      await act(async () => root.render(<Deployments app={app} />));
      expect(spy).toHaveBeenCalledTimes(2);
      const header = comparisonHeader();
      expect(header.textContent).toContain('0.4.0-beta.7');
      expect([...header.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Promote on Verticals']);
    });

    it('when the look fails, says it does not know rather than claiming the latest', async () => {
      vi.spyOn(api, 'appDeployments').mockImplementation((_s, o) => (o?.cursor === 'c1' ? Promise.reject(new Error('down')) : Promise.resolve(page1)));
      await act(async () => root.render(<Deployments app={app} />));
      expect(container.textContent).toContain('Could not check whether a newer version is waiting for prod.');
      expect(container.textContent).not.toContain('Running the latest version');
      expect(updateButtons()).toHaveLength(0);
    });
  });
});
