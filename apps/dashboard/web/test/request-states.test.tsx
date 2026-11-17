import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestFailed, requestLoading, requestOk, type RequestState } from '@substrat-run/ui/wa';
import type { AppRow, CatalogEntry, Deployment, Member } from '../src/lib/api';
import { Verticals } from '../src/views/Verticals';
import { Team } from '../src/views/Team';
import { CreateApp } from '../src/views/CreateApp';
import { Observability } from '../src/views/Observability';
import { Domains } from '../src/views/Domains';
import { button } from './wa';

/**
 * #3244: a list's empty state is a claim about the data, so it waits for an answer, and a
 * failed read is an error with a retry — never "nothing here". One table over every view the
 * issue named; each row is a view, its empty copy, and how it is handed a request.
 */

// Every read the views make besides the one under test stays in flight, so nothing else on
// the page settles into text the assertions could trip on.
const never = () => new Promise<never>(() => {});
const domainsRead = vi.hoisted(() => ({ listDomains: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => {
  const pending = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => new Promise(() => {})) });
  return {
    ...(await importOriginal<typeof import('../src/lib/api')>()),
    api: pending,
    teamApi: () => new Proxy(pending, { get: (t, key) => (key === 'listDomains' ? domainsRead.listDomains : Reflect.get(t, key)) }),
  };
});

const BUSY = '[role="status"][aria-busy="true"]';

interface PropView {
  view: string;
  empty: string;
  render: (state: RequestState<never[]>, onRetry: () => void) => ReactElement;
}

const VIEWS: PropView[] = [
  {
    view: 'Verticals',
    empty: 'Nothing pushed yet',
    render: (s, onRetry) => (
      <Verticals teamId="T" deployments={s as RequestState<Deployment[]>} onRetry={onRetry} onPromote={() => {}} onRemove={() => {}} onOpen={() => {}} busy={false} loadGitRepos={never} />
    ),
  },
  {
    view: 'Team',
    empty: 'No members yet.',
    render: (s, onRetry) => (
      <Team members={s as RequestState<Member[]>} onRetry={onRetry} meEmail="o@acme.test" canManage onInvite={async () => undefined} onResend={() => {}} onRevoke={() => {}} onRemove={() => {}} />
    ),
  },
  {
    view: 'Create app (catalog)',
    empty: 'Nothing is published to the marketplace yet.',
    render: (s, onRetry) => (
      <CreateApp catalog={s as RequestState<CatalogEntry[]>} onRetryCatalog={onRetry} authServers={[]} onCancel={() => {}} onCreate={async () => {}} />
    ),
  },
  {
    view: 'Observability (app picker)',
    empty: 'This team has no apps yet.',
    render: (s, onRetry) => (
      <Observability teamId="T" apps={s as RequestState<AppRow[]>} onRetryApps={onRetry} query="view=logs" scopeId={null} view="logs" focusEventType={null} cursor={null} onNav={() => {}} />
    ),
  },
  {
    view: 'Observability (Pulse apps table)',
    empty: 'No apps yet — traffic appears here once one is serving.',
    render: (s, onRetry) => (
      <Observability teamId="T" apps={s as RequestState<AppRow[]>} onRetryApps={onRetry} query="" scopeId={null} view={null} focusEventType={null} cursor={null} onNav={() => {}} />
    ),
  },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  domainsRead.listDomains.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const error = () => container.querySelector('[role="alert"]');

describe.each(VIEWS)('$view: loading, empty and error are three states (#3244)', ({ empty, render }) => {
  it('shows an announced skeleton and no empty state while the read is in flight', () => {
    act(() => root.render(render(requestLoading(), () => {})));
    expect(container.querySelector(BUSY)?.getAttribute('aria-label')).toMatch(/^Loading/);
    expect(container.textContent).not.toContain(empty);
  });

  it('shows the empty state only for a settled empty answer', () => {
    act(() => root.render(render(requestOk([]), () => {})));
    expect(container.textContent).toContain(empty);
    expect(container.querySelector(BUSY)).toBeNull();
  });

  it('shows a failed read as an error with a retry, never as empty', () => {
    const onRetry = vi.fn();
    act(() => root.render(render(requestFailed(new Error('upstream timed out')), onRetry)));
    expect(error()?.textContent).toContain('Could not read');
    expect(error()?.textContent).toContain('upstream timed out');
    expect(container.textContent).not.toContain(empty);
    act(() => button('Try again', container)!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('Domains: its own read, through the same states (#3244)', () => {
  const EMPTY = 'No custom domains yet.';
  const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

  it('skeleton while in flight, then the empty state for an empty answer', async () => {
    let answer!: (v: { entries: never[]; nextCursor: null }) => void;
    domainsRead.listDomains.mockReturnValue(new Promise((r) => (answer = r)));
    await act(async () => root.render(<Domains teamId="T" />));
    expect(container.querySelector(BUSY)).not.toBeNull();
    expect(container.textContent).not.toContain(EMPTY);
    await act(async () => answer({ entries: [], nextCursor: null }));
    expect(container.textContent).toContain(EMPTY);
    expect(container.querySelector(BUSY)).toBeNull();
  });

  it('a rejected read is an error with a retry — not "Loading…" forever, not empty', async () => {
    domainsRead.listDomains.mockRejectedValueOnce(new Error('plane unavailable')).mockReturnValueOnce(new Promise(() => {}));
    await act(async () => root.render(<Domains teamId="T" />));
    await settle();
    expect(error()?.textContent).toContain('plane unavailable');
    expect(container.textContent).not.toContain(EMPTY);
    expect(container.querySelector(BUSY)).toBeNull();
    await act(async () => button('Try again', container)!.click());
    expect(domainsRead.listDomains).toHaveBeenCalledTimes(2);
    expect(container.querySelector(BUSY)).not.toBeNull();
  });
});
