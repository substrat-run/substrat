import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestsMode } from '../src/views/RequestsMode';
import { RequestSlideOver } from '../src/views/RequestSlideOver';
import { failureDetail, RequestIdNote, requestIdOf } from '../src/components/RequestIdNote';
import { ApiError as ClientError } from '../src/lib/api.generated';
import { api, teamApi, ApiError, type CauseChain, type EffectsTree, type HistoryEntry, type InvocationEvents } from '../src/lib/api';
import { parseRequestId, requestLookup, REQUEST_WINDOW_MS } from '../src/lib/request-url';
import { recordFromLogs, relatedRequests } from '../src/lib/request-detail';

/** #2192: finding a request by the id a caller was given, and the requests that share its cause. */

// A ULID minted at 2026-09-29T08:36:02.323Z.
const MINTED = Date.parse('2026-09-29T08:36:02.323Z');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidAt = (ms: number, tail = 'A'): string => {
  let t = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[n % 32]! + t;
    n = Math.floor(n / 32);
  }
  return t + tail.repeat(16);
};
const ID = ulidAt(MINTED);
const OTHER_ID = ulidAt(MINTED - 60_000, 'B');

describe('parseRequestId', () => {
  it('reads the bare id in any case, with whitespace or quotes around it', () => {
    expect(parseRequestId(ID)).toBe(ID);
    expect(parseRequestId(`  ${ID.toLowerCase()}\n`)).toBe(ID);
    expect(parseRequestId(`"${ID}",`)).toBe(ID);
  });

  it('reads it out of a pasted header, a req= fragment and a dashboard link', () => {
    expect(parseRequestId(`x-substrat-request-id: ${ID}`)).toBe(ID);
    expect(parseRequestId(`req=${ID}`)).toBe(ID);
    expect(parseRequestId(`?req=${ID}&reqAt=1790670962323`)).toBe(ID);
    expect(parseRequestId(`https://dash.example/t/acme/observability?view=requests&req=${ID.toLowerCase()}&reqAt=1`)).toBe(ID);
    expect(parseRequestId(`{"error":"denied","requestId":"${ID}"}`)).toBe(ID);
  });

  it('opens nothing for text that names no single id', () => {
    for (const bad of ['', '   ', 'hello', ID.slice(1), `${ID}A`, ID.replace(/^./, 'I'), ID.replace(/^./, 'U'), `${ID} ${ID}`, `req=${ID}&req=${OTHER_ID}`, `?req=${ID}&requestId=${ID}`, `8${ID.slice(1)}`, 'Z'.repeat(26), 'req=', `req=${ID.slice(2)}`]) {
      expect(parseRequestId(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('requestLookup', () => {
  it('takes the instant from the id, and calls an id older than the log window outside it', () => {
    expect(requestLookup(ID, MINTED + 1000)).toEqual({ atMs: MINTED, outside: false });
    expect(requestLookup(ID, MINTED + REQUEST_WINDOW_MS + 1)).toEqual({ atMs: MINTED, outside: true });
    expect(requestLookup('nope')).toBeNull();
  });
});

const entry = (id: string, type: string, invocationId: string | null, over: Partial<HistoryEntry> = {}) =>
  ({ id, type, occurredAt: new Date(MINTED).toISOString(), invocationId, causedBy: null, ...over }) as unknown as HistoryEntry;
const OWN = ID;
const OTHER = ulidAt(MINTED - 60_000, 'B');
const RETRY = ulidAt(MINTED + 600_000, 'C');
const tree = (root: EffectsTree['root']): EffectsTree => ({ root, terminal: 'complete', count: 1 });
const delivery = (invocationId: string | null) => ({ consumer: 'notify', state: 'delivered', at: new Date(MINTED + 5).toISOString(), attempts: 1, error: null, invocationId });

describe('relatedRequests', () => {
  it('is empty when everything ran inside the call, and when nothing was emitted', () => {
    expect(relatedRequests(OWN, [], [])).toEqual([]);
    const inside = tree({ event: entry('E1', 'a.b', OWN), deliveries: [delivery(OWN), delivery(null)], effects: [{ event: entry('E2', 'a.c', OWN), deliveries: [], effects: [] }] } as unknown as EffectsTree['root']);
    expect(relatedRequests(OWN, [inside], [])).toEqual([]);
  });

  it('names the call that emitted the event this one reacted to', () => {
    const chain = { chain: [entry('E1', 'a.b', OWN, { causedBy: 'E0' }), entry('E0', 'a.root', OTHER)], terminal: 'operation' } as unknown as CauseChain;
    expect(relatedRequests(OWN, [], [chain])).toMatchObject([{ relation: 'caused-by', invocationId: OTHER, via: 'a.root' }]);
  });

  it('skips causes emitted in this call and walks on to the first foreign one', () => {
    const chain = { chain: [entry('E2', 'a.c', OWN), entry('E1', 'a.b', OWN), entry('E0', 'a.root', null), entry('E00', 'a.first', OTHER)], terminal: 'operation' } as unknown as CauseChain;
    expect(relatedRequests(OWN, [], [chain])).toMatchObject([{ invocationId: OTHER }]);
  });

  it('lists a delivery attempted in another call and an event another call emitted, each once', () => {
    const t = tree({
      event: entry('E1', 'a.b', OWN),
      deliveries: [delivery(RETRY), delivery(RETRY)],
      effects: [{ event: entry('E2', 'a.later', OTHER), deliveries: [delivery(RETRY)], effects: [] }],
    } as unknown as EffectsTree['root']);
    const out = relatedRequests(OWN, [t], []);
    expect(out.map((r) => [r.relation, r.invocationId]).sort()).toEqual([['set-off', OTHER], ['set-off', RETRY]].sort());
  });

  it('keeps the cause label when the same call also set this one off, and never lists itself', () => {
    const chain = { chain: [entry('E1', 'a.b', OWN), entry('E0', 'a.root', OTHER)], terminal: 'operation' } as unknown as CauseChain;
    const t = tree({ event: entry('E1', 'a.b', OWN), deliveries: [delivery(OTHER), delivery(OWN)], effects: [] } as unknown as EffectsTree['root']);
    expect(relatedRequests(OWN, [t], [chain])).toMatchObject([{ relation: 'caused-by', invocationId: OTHER }]);
  });
});

describe('a peer call’s parent (#2192)', () => {
  const line = (source: Record<string, unknown>) => ({
    timestamp: MINTED,
    level: 'info',
    message: null,
    raw: { timestamp: MINTED, source: { substrat: 'invocation', invocationId: OWN, method: 'POST', ...source } },
  });

  it('lists the calling request as the cause, at the instant its id was minted', () => {
    const record = recordFromLogs([line({ parentInvocationId: OTHER })]);
    expect(record?.parentInvocationId).toBe(OTHER);
    expect(relatedRequests(OWN, [], [], record)).toEqual([
      { relation: 'caused-by', invocationId: OTHER, at: new Date(MINTED - 60_000).toISOString(), via: 'peer call', scopeId: null },
    ]);
    // With the calling app named, it is where the link opens; a malformed one names none.
    expect(relatedRequests(OWN, [], [], recordFromLogs([line({ parentInvocationId: OTHER, parentScopeId: RETRY })]))[0]!.scopeId).toBe(RETRY);
    expect(relatedRequests(OWN, [], [], recordFromLogs([line({ parentInvocationId: OTHER, parentScopeId: 'app-b' })]))[0]!.scopeId).toBeNull();
  });

  it.each([
    ['absent', {}],
    ['not an id', { parentInvocationId: 'drop table' }],
    ['lowercased', { parentInvocationId: OTHER.toLowerCase() }],
    ['two joined', { parentInvocationId: `${OTHER}, ${OTHER}` }],
    ['not a string', { parentInvocationId: 7 }],
  ])('reads no parent from a line whose parent is %s', (_name, source) => {
    const record = recordFromLogs([line(source)]);
    expect(record?.parentInvocationId).toBeNull();
    expect(relatedRequests(OWN, [], [], record)).toEqual([]);
  });

  it('never lists the request as its own parent', () => {
    expect(relatedRequests(OWN, [], [], { parentInvocationId: OWN })).toEqual([]);
  });
});

describe('a team-client failure’s request id (#2192): install, retry and resume', () => {
  it('reads it from the problem body the generated client keeps, and puts it in the toast text', () => {
    const e = new ClientError(502, 'install failed', { title: 'Bad Gateway', detail: 'install failed', requestId: ID });
    expect(requestIdOf(e)).toBe(ID);
    expect(failureDetail(e)).toBe(`install failed (request id ${ID})`);
  });

  it('reads none from a body without one, or with something that is not an id', () => {
    for (const body of [null, 'text', {}, { requestId: 'nope' }, { requestId: 7 }, { requestId: `${ID} ${ID}` }]) {
      const e = new ClientError(500, 'boom', body);
      expect(requestIdOf(e), JSON.stringify(body)).toBeUndefined();
      expect(failureDetail(e)).toBe('boom');
    }
    expect(failureDetail(new Error('plain'))).toBe('plain');
    expect(failureDetail('thrown string')).toBe('thrown string');
  });
});

describe('ApiError.requestId', () => {
  afterEach(() => vi.unstubAllGlobals());
  const failWith = async (init: ResponseInit, body: unknown) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' }, ...init }));
    return teamApi('team-a').readAppInvocation({ scopeId: 'app-a', invocationId: 'X' }).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
  };

  it('reads the id from the response header, and from the problem body when there is no header', async () => {
    expect((await failWith({ headers: { 'x-substrat-request-id': ID } }, { detail: 'no' }))?.requestId).toBe(ID);
    expect((await failWith({}, { detail: 'no', requestId: OTHER }))?.requestId).toBe(OTHER);
  });

  it('ignores an id that is not shaped like one, from the body and from the header', async () => {
    expect((await failWith({}, { detail: 'no', requestId: 'x'.repeat(500) }))?.requestId).toBeUndefined();
    expect((await failWith({}, { detail: 'no', requestId: `8${ID.slice(1)}` }))?.requestId).toBeUndefined();
    expect((await failWith({ headers: { 'x-substrat-request-id': 'nonsense' } }, { detail: 'no', requestId: OTHER }))?.requestId).toBe(OTHER);
  });

  it('has none when the answer named none', async () => {
    expect((await failWith({}, { detail: 'no' }))?.requestId).toBeUndefined();
  });
});

describe('the request-finding surfaces', () => {
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

  const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

  const renderMode = async () => {
    vi.spyOn(api, 'appRequestVolume').mockResolvedValue({ bucketMs: 60_000, buckets: [], estimated: false });
    vi.spyOn(api, 'appRequestFacets').mockResolvedValue({ total: 0, facets: {}, estimated: false } as never);
    vi.spyOn(api, 'appRequests').mockResolvedValue([]);
    const onOpenCall = vi.fn();
    await act(async () =>
      root.render(
        <RequestsMode teamId="team-a" scopeId="app-a" q={{}} window={{ from: '2026-09-29T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' }} nonce={0} onFilters={vi.fn()} onRange={vi.fn()} onOpenCall={onOpenCall} />,
      ),
    );
    await settle();
    return onOpenCall;
  };
  const type = async (text: string) => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Find a request by id"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };

  it('opens a pasted id at the instant the id was minted', async () => {
    const onOpenCall = await renderMode();
    await type(`  req=${ID.toLowerCase()} `);
    expect(onOpenCall).toHaveBeenCalledWith(ID, MINTED);
  });

  it('says so for text that is not an id, and opens nothing', async () => {
    const onOpenCall = await renderMode();
    await type('not an id');
    expect(onOpenCall).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('not a request id');
  });

  const renderPanel = async (id: string, at: number) => {
    await act(async () => root.render(<RequestSlideOver teamId="team-a" scopeId="app-a" invocationId={id} atMs={at} onClose={vi.fn()} />));
    await settle();
  };

  it('says "not found within the 72-hour window" for an old id, without asking the plane', async () => {
    const logs = vi.spyOn(api, 'appTenantLogs');
    vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [], truncated: false } as InvocationEvents);
    const old = Date.now() - REQUEST_WINDOW_MS - 3_600_000;
    await renderPanel(ulidAt(old), old);
    expect(logs).not.toHaveBeenCalled();
    expect(container.textContent).toContain('within the 72-hour log window');
  });

  it('says the id was not found in this app when the plane has no line for it', async () => {
    vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
    vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [], truncated: false } as InvocationEvents);
    const recent = Date.now() - 60_000;
    await renderPanel(ulidAt(recent), recent);
    expect(container.textContent).toContain('was found in this app within the log window');
    expect(container.textContent).toContain('No other request is recorded as sharing a cause');
  });

  it('lists the request that caused this one and the retry it set off', async () => {
    vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
    vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [entry('E1', 'acme.assigned', OWN, { causedBy: 'E0' })], truncated: false } as InvocationEvents);
    vi.spyOn(api, 'appEventEffects').mockResolvedValue(
      tree({ event: entry('E1', 'acme.assigned', OWN), deliveries: [delivery(RETRY)], effects: [] } as unknown as EffectsTree['root']),
    );
    const cause = vi.spyOn(api, 'appEventCause').mockResolvedValue({ chain: [entry('E1', 'acme.assigned', OWN, { causedBy: 'E0' }), entry('E0', 'acme.root', OTHER)], terminal: 'operation' } as unknown as CauseChain);
    await renderPanel(OWN, MINTED);
    expect(cause).toHaveBeenCalledTimes(1);
    const text = container.textContent!;
    expect(text).toContain('Caused by');
    expect(text).toContain('Set off');
    expect(text).toContain('acme.root');
    expect(text).toContain('acme.assigned → notify');
  });

  describe('a peer call’s parent: opened in the CALLING app, when the team holds it (#2192)', () => {
    const at = Date.now() - 60_000;
    const child = ulidAt(at, 'D');
    const parent = ulidAt(at - 1_000, 'E');
    const callerApp = ulidAt(at - 86_400_000, 'F');
    const childLine = (source: Record<string, unknown>) =>
      [{ timestamp: at, level: 'info', message: null, raw: { timestamp: at, source: { substrat: 'invocation', invocationId: child, method: 'POST', parentInvocationId: parent, ...source } } }] as never;
    const parentLine = [{ timestamp: at, level: 'info', message: null, raw: { timestamp: at, source: { substrat: 'invocation', invocationId: parent, method: 'GET', path: '/api/board' } } }] as never;
    const openButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open');
    const render = async (id: string, scope: string, teamApps: string[]) => {
      await act(async () => root.render(<RequestSlideOver teamId="team-a" scopeId={scope} invocationId={id} atMs={at} onClose={vi.fn()} teamApps={teamApps} />));
      await settle();
    };
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('links the caller in its own app, and that app’s read finds the parent’s line', async () => {
      // The plane, as the dashboard worker narrows it: a read is per app, so the parent's line is
      // found only under the calling app's scope.
      const logs = vi.spyOn(api, 'appTenantLogs').mockImplementation(async (_team, scope, q) => {
        const id = (q as { invocationId?: string }).invocationId;
        if (scope === 'app-a' && id === child) return childLine({ parentScopeId: callerApp });
        if (scope === callerApp && id === parent) return parentLine;
        return [];
      });
      vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [], truncated: false } as InvocationEvents);
      await render(child, 'app-a', ['app-a', callerApp]);
      expect(container.textContent).toContain('peer call');
      await act(async () => openButton()!.click());
      const url = new URL(window.location.href);
      expect([url.searchParams.get('req'), url.searchParams.get('reqScope')]).toEqual([parent, callerApp]);
      // What the page then renders for that address: the panel in the calling app.
      await render(parent, url.searchParams.get('reqScope')!, ['app-a', callerApp]);
      expect(logs.mock.calls.at(-1)).toEqual(['team-a', callerApp, expect.objectContaining({ invocationId: parent })]);
      expect(container.textContent).toContain('/api/board');
      expect(container.textContent).not.toContain('was found in this app within the log window');
    });

    it('shows the caller without a link when the team does not hold its app, and reads nothing there', async () => {
      const logs = vi.spyOn(api, 'appTenantLogs').mockImplementation(async (_team, scope, q) =>
        scope === 'app-a' && (q as { invocationId?: string }).invocationId === child ? childLine({ parentScopeId: callerApp }) : [],
      );
      vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [], truncated: false } as InvocationEvents);
      await render(child, 'app-a', ['app-a']);
      expect(container.textContent).toContain('Caused by');
      expect(container.textContent).toContain('peer call');
      expect(openButton()).toBeUndefined();
      expect(logs.mock.calls.every(([, scope]) => scope === 'app-a')).toBe(true);
    });

    it('shows the caller without a link when the line names no scope for it (written before the field)', async () => {
      vi.spyOn(api, 'appTenantLogs').mockImplementation(async (_team, _scope, q) =>
        (q as { invocationId?: string }).invocationId === child ? childLine({}) : [],
      );
      vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [], truncated: false } as InvocationEvents);
      await render(child, 'app-a', ['app-a', callerApp]);
      expect(container.textContent).toContain('peer call');
      expect(openButton()).toBeUndefined();
    });
  });

  describe('related requests that could not all be checked', () => {
    const reacting = (n: number) => Array.from({ length: n }, (_, i) => entry(`R${i}`, 'acme.react', OWN, { causedBy: 'E0' }));
    const plain = (n: number) => Array.from({ length: n }, (_, i) => entry(`P${i}`, 'acme.plain', OWN));
    const noTree = tree(null);
    const text = () => container.textContent!;

    it('does not say none are recorded when a read was rejected', async () => {
      vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
      vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: reacting(1), truncated: false } as InvocationEvents);
      vi.spyOn(api, 'appEventEffects').mockRejectedValue(new ApiError(503, 'busy'));
      vi.spyOn(api, 'appEventCause').mockResolvedValue({ chain: [], terminal: 'operation' } as unknown as CauseChain);
      await renderPanel(OWN, MINTED);
      expect(text()).toContain('Some related requests could not be checked: 1 read failed');
      expect(text()).not.toContain('No other request is recorded');
    });

    it('says how many events were not traced back past the cause cap, and still lists what was found', async () => {
      vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
      vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: reacting(4), truncated: false } as InvocationEvents);
      vi.spyOn(api, 'appEventEffects').mockResolvedValue(noTree);
      const cause = vi.spyOn(api, 'appEventCause').mockResolvedValue({ chain: [entry('R', 'acme.react', OWN), entry('E0', 'acme.root', OTHER)], terminal: 'operation' } as unknown as CauseChain);
      await renderPanel(OWN, MINTED);
      expect(cause).toHaveBeenCalledTimes(3);
      expect(text()).toContain('only the first 3 of 4 events that reacted to another were traced back');
      expect(text()).toContain('acme.root');
    });

    it('says so past the effects cap', async () => {
      vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
      vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: plain(11), truncated: false } as InvocationEvents);
      const effects = vi.spyOn(api, 'appEventEffects').mockResolvedValue(noTree);
      await renderPanel(OWN, MINTED);
      expect(effects).toHaveBeenCalledTimes(10);
      expect(text()).toContain('only the first 10 of 11 events were followed');
      expect(text()).not.toContain('No other request is recorded');
    });

    it('keeps the plain none sentence when every read was made (the positive twin)', async () => {
      vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
      vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: plain(2), truncated: false } as InvocationEvents);
      vi.spyOn(api, 'appEventEffects').mockResolvedValue(noTree);
      await renderPanel(OWN, MINTED);
      expect(text()).toContain('No other request is recorded as sharing a cause');
      expect(text()).not.toContain('could not be checked');
    });
  });

  it('renders a request id to quote, and nothing without one', async () => {
    await act(async () => root.render(<RequestIdNote id={ID} />));
    expect(container.textContent).toContain('Request id:');
    expect(container.textContent).toContain(ID);
    await act(async () => root.render(<RequestIdNote id={undefined} />));
    expect(container.textContent).toBe('');
  });
});
