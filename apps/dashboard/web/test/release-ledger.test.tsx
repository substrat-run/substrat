import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AppDeployments, type AppRow } from '../src/lib/api';
import { MOCK_APP_PERMISSIONS } from '../src/lib/mock';
import { MOCK_APP_DEPLOYMENTS, MOCK_APP_MODEL_UPDATE, MOCK_APP_RELEASES, MOCK_PROD_HISTORY } from '../src/lib/mock-deployments';
import { diffRegistries } from '../src/lib/registry-diff';
import { instant, ledgerRows, permissionDiffItems, registryLedgerRows, schemaDiffItems } from '../src/lib/release-ledger';
import { liveCell, ReleaseComparisonCard, ReleasesCard, type Ledger } from '../src/views/ReleaseCards';

const byVersion = (rows: ReturnType<typeof ledgerRows>, v: string) => rows.find((r) => r.version === v)!;

describe('ledgerRows (#1767)', () => {
  const rows = ledgerRows(MOCK_APP_RELEASES, MOCK_PROD_HISTORY);

  it('reads a prod move back to an OLDER version as a rollback of the one it replaced', () => {
    expect(byVersion(rows, '0.4.0-beta.7').rolledBackAfterMs).toBe(6 * 60_000);
    expect(liveCell(byVersion(rows, '0.4.0-beta.7'), 'ledger').text).toBe('rolled back after 6 min');
    // The version prod returned to is live again — restored, not rolled back.
    expect(byVersion(rows, '0.3.0')).toMatchObject({ rolledBackAfterMs: null, restored: true, actor: 'dana@acme.com' });
    // A forward move is not a rollback of what it replaced.
    expect(byVersion(rows, '0.2.0')).toMatchObject({ rolledBackAfterMs: null, restored: false, liveAfterMs: 8 * 60_000 });
  });

  it('keeps pushed and went live apart: a push that never went live says so', () => {
    expect(byVersion(rows, '0.1.0')).toMatchObject({ wentLiveAt: null, actor: null });
    expect(liveCell(byVersion(rows, '0.1.0'), 'ledger').text).toBe('not live');
  });

  it('counts installs as pins, plus the ones following prod on the prod row only', () => {
    expect(rows.map((r) => [r.version, r.installs])).toEqual([
      ['0.4.0-beta.7', { on: 0, total: 4 }],
      ['0.3.0', { on: 2, total: 4 }],
      ['0.2.0', { on: 1, total: 4 }],
      ['0.1.0', { on: 0, total: 4 }],
      ['0.0.5', { on: 1, total: 4 }],
    ]);
  });

  it('leaves who and rollback unknown when the history read failed', () => {
    const blind = ledgerRows(MOCK_APP_RELEASES, null);
    expect(byVersion(blind, '0.4.0-beta.7')).toMatchObject({ rolledBackAfterMs: null, actor: null });
    expect(byVersion(blind, '0.4.0-beta.7').wentLiveAt).not.toBeNull();
  });

  it('gives an installed app the pushes only, and nothing it cannot see as zero', () => {
    const reg = registryLedgerRows(MOCK_APP_DEPLOYMENTS.versions, '01J2Q8Z3V9K4W7X2M5N6P7V300');
    expect(reg.every((r) => r.installs === null && r.wentLiveAt === null && r.actor === null)).toBe(true);
    expect(liveCell(byVersion(reg, '0.3.0'), 'registry').text).toBe('in prod');
    expect(liveCell(byVersion(reg, '0.2.0'), 'registry').text).toBe('—');
  });

  it('prints instants the way the design does', () => {
    const now = Date.parse('2026-07-23T12:00:00Z');
    expect(instant('2026-07-23T09:42:00Z', now)).toMatch(/^Thu \d\d:\d\d$/);
    expect(instant('2026-07-01T09:42:00Z', now)).toMatch(/^1 Jul \d\d:\d\d$/);
  });
});

describe('comparison diffs (#1767)', () => {
  it('tags permission changes added / changed / removed, roles included', () => {
    const { running, update } = MOCK_APP_PERMISSIONS;
    const items = permissionDiffItems(diffRegistries(running.registry!, update!.registry!), running.registry!, update!.registry!);
    expect(items).toContainEqual({ kind: 'added', name: 'helpdesk:ticket-reassign', note: 'Move a ticket to another agent or queue' });
    expect(items.find((i) => i.name === 'helpdesk:ticket-escalate')?.kind).toBe('removed');
    expect(items.find((i) => i.name === 'role agent')).toMatchObject({ kind: 'changed', note: '+helpdesk:ticket-reassign' });
  });

  it('diffs the entity models field by field, and refuses to call a missing model "no change"', () => {
    const { running, update } = MOCK_APP_MODEL_UPDATE;
    expect(schemaDiffItems(running.model, update!.model)).toEqual([
      { kind: 'added', name: 'ticket.priority', note: 'enum(3), optional' },
      { kind: 'changed', name: 'ticket.subject', note: 'string → string, optional' },
    ]);
    expect(schemaDiffItems(running.model, null)).toBeNull();
    expect(schemaDiffItems(running.model, running.model)).toEqual([]);
  });
});

describe('Deployments cards', () => {
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

  const app = { app_scope_id: 'S1', name: 'Acme HR', vertical_slug: 'acme/helpdesk', status: 'active' } as AppRow;
  const dep = MOCK_APP_DEPLOYMENTS;
  const v = (version: string) => dep.versions.find((x) => x.version === version)!;
  const column = (title: string) => container.querySelector(`[data-diff-column="${title}"]`)!.textContent;

  it('compares running with the update target from the per-app reads, with the action in its header', async () => {
    vi.spyOn(api, 'releaseComparison').mockResolvedValue({ running: null, update: null, metricsAvailable: false, owned: true });
    vi.spyOn(api, 'appPermissions').mockResolvedValue(MOCK_APP_PERMISSIONS);
    vi.spyOn(api, 'appModel').mockResolvedValue(MOCK_APP_MODEL_UPDATE);
    const ledger: Ledger = { rows: ledgerRows(MOCK_APP_RELEASES, MOCK_PROD_HISTORY), source: 'ledger', failed: false };
    await act(async () =>
      root.render(<ReleaseComparisonCard app={app} dep={dep} running={v('0.2.0')} target={{ version: v('0.3.0'), state: 'update' }} ledger={ledger} actions={<button>Update this app</button>} />),
    );
    expect(container.textContent).toContain('went live 20 Jul');
    expect(container.textContent).toContain('in prod, not on this app');
    expect(column('Permissions')).toContain('− removed');
    expect(column('Permissions')).toContain('helpdesk:ticket-escalate');
    expect(column('Schema')).toContain('ticket.priority');
    expect(column('Operations')).toContain('Not compared yet');
    expect(container.querySelector('button')?.textContent).toBe('Update this app');
  });

  it('shows an unpromoted push of another team as theirs to review, without asking the promote review', async () => {
    vi.spyOn(api, 'releaseComparison').mockResolvedValue({ running: null, update: null, metricsAvailable: false, owned: false });
    const review = vi.spyOn(api, 'promoteReview');
    const theirs: AppDeployments = { ...dep, owned: false };
    await act(async () => root.render(<ReleaseComparisonCard app={app} dep={theirs} running={v('0.3.0')} target={{ version: v('0.4.0-beta.7'), state: 'unpromoted' }} ledger={null} />));
    expect(review).not.toHaveBeenCalled();
    expect(column('Permissions')).toContain('the review is theirs to read');
    expect(container.textContent).toContain('not live');
    expect(container.textContent).toContain('numbers stay with them');
  });

  it('says the app is current rather than hiding', async () => {
    vi.spyOn(api, 'releaseComparison').mockResolvedValue({ running: null, update: null, metricsAvailable: false, owned: true });
    await act(async () => root.render(<ReleaseComparisonCard app={app} dep={dep} running={v('0.3.0')} target={null} ledger={null} />));
    expect(container.textContent).toContain('Running the latest version — nothing to update to.');
  });

  it('lists releases with the rollback in words, and a row opens its version', async () => {
    const onPick = vi.fn();
    const ledger: Ledger = { rows: ledgerRows(MOCK_APP_RELEASES, MOCK_PROD_HISTORY), source: 'ledger', failed: false };
    await act(async () => root.render(<ReleasesCard ledger={ledger} onPick={onPick} />));
    const row = container.querySelector('[data-release="0.4.0-beta.7"]')!;
    expect(row.querySelector('[data-live]')!.textContent).toBe('rolled back after 6 min');
    expect(row.querySelector('[data-installs]')!.textContent).toBe('0 / 4');
    await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onPick).toHaveBeenCalledWith('01J2Q8Z3V9K4W7X2M5N6P7V400');
  });

  it('renders an installed app’s list with dashes, not zeros, and says whose record it is', async () => {
    const ledger: Ledger = { rows: registryLedgerRows(dep.versions, '01J2Q8Z3V9K4W7X2M5N6P7V300'), source: 'registry', failed: false };
    await act(async () => root.render(<ReleasesCard ledger={ledger} onPick={() => undefined} />));
    const installs = [...container.querySelectorAll('[data-installs]')].map((e) => e.textContent);
    expect(installs.every((t) => t === '—')).toBe(true);
    expect(container.textContent).toContain('publishing team’s record');
  });
});
