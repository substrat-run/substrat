import { describe, it, expect, afterEach } from 'vitest';
import {
  parseTtlHours,
  formatPreviews,
  createPreview,
  deletePreview,
  listPreviews,
  type PreviewRow,
} from '../src/preview.js';

describe('parseTtlHours', () => {
  it('reads bare hours, Nh, and Nd', () => {
    expect(parseTtlHours(undefined)).toBeUndefined();
    expect(parseTtlHours('72')).toBe(72);
    expect(parseTtlHours('72h')).toBe(72);
    expect(parseTtlHours('3d')).toBe(72);
  });
  it('reads none/pinned as null (pinned), distinct from undefined (default 72h)', () => {
    expect(parseTtlHours('none')).toBeNull();
    expect(parseTtlHours('pinned')).toBeNull();
    expect(parseTtlHours('NONE')).toBeNull();
    // null (pin) and undefined (default) are different intents — neither is the other.
    expect(parseTtlHours('none')).not.toBeUndefined();
  });
  it('rejects garbage rather than sending a nonsense TTL', () => {
    expect(() => parseTtlHours('soon')).toThrow(/invalid --ttl/);
  });
});

describe('formatPreviews', () => {
  it('renders a placeholder when there are none', () => {
    expect(formatPreviews([])).toBe('(no active previews)');
  });
  it('renders tag, url and expiry per row', () => {
    const rows: PreviewRow[] = [
      { scopeId: 'S1', tag: 'pr-7', versionId: '01J', forkedFrom: 'P1', expiresAt: '2026-08-01T00:00:00Z', hostname: 'h--pr-7.global.substrat.run', url: 'https://h--pr-7.global.substrat.run' },
    ];
    const out = formatPreviews(rows);
    expect(out).toContain('pr-7');
    expect(out).toContain('h--pr-7.global.substrat.run');
    expect(out).toContain('expires 2026-08-01T00:00:00Z');
  });
});

describe('preview client', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stub = (
    handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  ): { calls: { url: string; method: string; body: unknown }[] } => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const parsed = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init.method ?? 'GET', body: parsed });
      const { status = 200, body } = handler(url, init);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls };
  };

  const base = { controlPlaneUrl: 'https://cp.example/api', header: { 'x-service-token': 't' }, slug: 'helpdesk' };

  it('POSTs a create with only the fields that are set', async () => {
    const { calls } = stub(() => ({
      status: 201,
      body: { scopeId: 'S1', hostname: 'h--pr-7.x', url: 'https://h--pr-7.x', versionId: '01J', reused: false },
    }));
    const out = await createPreview({ ...base, tag: 'pr-7', versionId: '01J', ttlHours: 72 });
    expect(out.reused).toBe(false);
    expect(calls[0]!.url).toBe('https://cp.example/api/verticals/helpdesk/previews');
    expect(calls[0]!.method).toBe('POST');
    // Absent optionals are omitted, not sent as undefined.
    expect(calls[0]!.body).toEqual({ tag: 'pr-7', versionId: '01J', ttlHours: 72 });
  });

  it('sends empty:true for a clean-room preview (#509 (b))', async () => {
    const { calls } = stub(() => ({
      status: 201,
      body: { scopeId: 'S1', hostname: 'h--pr-1.x', url: 'https://h--pr-1.x', versionId: '01J', reused: false },
    }));
    await createPreview({ ...base, tag: 'pr-1', versionId: '01J', empty: true });
    // No sourceScopeId when clean-room; `empty` rides as an explicit true.
    expect(calls[0]!.body).toEqual({ tag: 'pr-1', versionId: '01J', empty: true });
  });

  it('surfaces a server error body as the thrown message', async () => {
    stub(() => ({ status: 403, body: { error: 'previews are available for private (unlisted) verticals only' } }));
    await expect(createPreview({ ...base, tag: 'pr-1', versionId: '01J' })).rejects.toThrow(/private/);
  });

  it('reads a problem document the way every other command does (#971)', async () => {
    stub(() => ({
      status: 409,
      body: {
        type: 'https://substrat.net/problems/conflict',
        title: 'Conflict',
        status: 409,
        detail: 'a preview for tag pr-1 is being created',
        code: 'conflict',
      },
    }));
    await expect(createPreview({ ...base, tag: 'pr-1', versionId: '01J' })).rejects.toThrow(
      'preview create failed (409 conflict): a preview for tag pr-1 is being created',
    );
  });

  it('names the field a legacy Zod refusal complained about', async () => {
    // The pre-#113 `{ error, issues }` body: 'invalid request' alone is unactionable.
    stub(() => ({
      status: 400,
      body: { error: 'invalid request', issues: [{ path: ['ttlHours'], message: 'Expected number, received string' }] },
    }));
    await expect(listPreviews(base)).rejects.toThrow(/ttlHours: Expected number, received string/);
  });

  it('DELETE hits the tag path and returns the reaped scope', async () => {
    const { calls } = stub(() => ({ body: { deleted: 'S1' } }));
    const out = await deletePreview({ ...base, tag: 'pr-7' });
    expect(out.deleted).toBe('S1');
    expect(calls[0]!.url).toBe('https://cp.example/api/verticals/helpdesk/previews/pr-7');
    expect(calls[0]!.method).toBe('DELETE');
  });

  it('GET lists previews', async () => {
    stub(() => ({ body: [{ scopeId: 'S1', tag: 'pr-7', versionId: '01J', forkedFrom: 'P', expiresAt: null, hostname: null, url: null }] }));
    const rows = await listPreviews(base);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tag).toBe('pr-7');
  });
});
