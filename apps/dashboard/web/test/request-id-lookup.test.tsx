import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestsMode } from '../src/views/RequestsMode';
import { RequestSlideOver } from '../src/views/RequestSlideOver';
import { RequestIdNote } from '../src/components/RequestIdNote';
import { api, ApiError, type CauseChain, type EffectsTree, type HistoryEntry, type InvocationEvents } from '../src/lib/api';
import { parseRequestId, requestLookup, REQUEST_WINDOW_MS } from '../src/lib/request-url';
import { relatedRequests } from '../src/lib/request-detail';

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
    for (const bad of ['', '   ', 'hello', ID.slice(1), `${ID}A`, ID.replace(/^./, 'I'), ID.replace(/^./, 'U'), `${ID} ${ID}`, 'req=', `req=${ID.slice(2)}`]) {
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

describe('ApiError.requestId', () => {
  afterEach(() => vi.unstubAllGlobals());
  const failWith = async (init: ResponseInit, body: unknown) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' }, ...init }));
    return api.appInvocationEvents('app-a', 'X').then(
      () => null,
      (e: unknown) => e as ApiError,
    );
  };

  it('reads the id from the response header, and from the problem body when there is no header', async () => {
    expect((await failWith({ headers: { 'x-substrat-request-id': ID } }, { detail: 'no' }))?.requestId).toBe(ID);
    expect((await failWith({}, { detail: 'no', requestId: OTHER }))?.requestId).toBe(OTHER);
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
        <RequestsMode scopeId="app-a" q={{}} window={{ from: '2026-09-29T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' }} nonce={0} onFilters={vi.fn()} onRange={vi.fn()} onOpenCall={onOpenCall} />,
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
    await act(async () => root.render(<RequestSlideOver scopeId="app-a" invocationId={id} atMs={at} onClose={vi.fn()} />));
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

  it('renders a request id to quote, and nothing without one', async () => {
    await act(async () => root.render(<RequestIdNote id={ID} />));
    expect(container.textContent).toContain('Request id:');
    expect(container.textContent).toContain(ID);
    await act(async () => root.render(<RequestIdNote id={undefined} />));
    expect(container.textContent).toBe('');
  });
});
