import { describe, expect, it } from 'vitest';
import { ControlPlaneError } from '@substrat-run/control-plane-api/browser';
import { ApiError, createApi, walkAll } from '../src/lib/api';

/**
 * `lib/api.ts` is now a thin skin over the control-plane client (#971). What the views rely
 * on is what is pinned here: which credential goes out, that a refusal is still an
 * `ApiError` carrying its status, and what an unreachable plane reads as.
 */

function withFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe('createApi', () => {
  it('sends the dev actor, the cookie opt-in and the /api base', async () => {
    const f = withFetch(() => Response.json({ staff: [] }));
    try {
      await createApi('dev-actor').listMembers();
      expect(f.calls[0]!.url).toBe('/api/members');
      expect(f.calls[0]!.init.credentials).toBe('include');
      expect(f.calls[0]!.init.headers).toEqual({ 'x-platform-actor': 'dev-actor', 'content-type': 'application/json' });
    } finally {
      f.restore();
    }
  });

  it.each([null, ''])('sends no actor header in session mode (%j) — the cookie authenticates', async (actor) => {
    const f = withFetch(() => Response.json({ staff: [] }));
    try {
      await createApi(actor, '/cp').listMembers();
      expect(f.calls[0]!.url).toBe('/cp/members');
      expect(f.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
      expect(f.calls[0]!.init.credentials).toBe('include');
    } finally {
      f.restore();
    }
  });

  it('throws an ApiError carrying the status and the problem detail', async () => {
    const f = withFetch(() => Response.json({ detail: 'not configured' }, { status: 501 }));
    try {
      const err = await createApi(null).serviceMetrics(1).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err).toMatchObject({ status: 501, message: 'not configured' });
    } finally {
      f.restore();
    }
  });

  it('reads an unreachable plane as an ApiError at status 0 whose message a view can show', async () => {
    const f = withFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    try {
      const err = await createApi(null).listMembers().catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(0);
      // Not a 501, so no view mistakes it for "unconfigured"; and the sentence a toast shows.
      expect(err.status).not.toBe(501);
      expect(err instanceof Error ? err.message : String(err)).toBe('control plane unreachable: Failed to fetch');
    } finally {
      f.restore();
    }
  });

  it('an ApiError built by hand still reads as one (the view tests construct them)', () => {
    const e = new ApiError(409, 'conflict');
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, message: 'conflict', name: 'ControlPlaneError' });
  });

  it('hands a method round as a callback, as Scopes.tsx does', async () => {
    const f = withFetch(() => Response.json({ id: 's' }));
    try {
      const { suspendScope } = createApi(null);
      await suspendScope('t' as never, 's' as never);
      expect(f.calls[0]!.url).toBe('/api/tenants/t/scopes/s/suspend');
    } finally {
      f.restore();
    }
  });
});

describe('walkAll', () => {
  it('walks pages to the end of the cursor, never a trailing empty fetch', async () => {
    const pages = [
      { entries: [1, 2], nextCursor: 'a' },
      { entries: [3], nextCursor: null },
    ];
    const seen: (string | undefined)[] = [];
    const all = await walkAll(async ({ cursor }) => {
      seen.push(cursor);
      return pages.shift()!;
    });
    expect(all).toEqual([1, 2, 3]);
    expect(seen).toEqual([undefined, 'a']);
  });
});
