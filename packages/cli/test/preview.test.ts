import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parseTtlHours,
  formatPreviews,
  createPreview,
  deletePreview,
  listPreviews,
  formatPreviewLogin,
  type PreviewCreated,
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

describe('formatPreviewLogin (#1704) — a preview without a working login is never silent', () => {
  const created = (over: Partial<PreviewCreated> = {}): PreviewCreated => ({
    scopeId: 'S1',
    hostname: 'desk--pr-7.global.substrat.run',
    url: 'https://desk--pr-7.global.substrat.run',
    versionId: 'V1',
    reused: false,
    ...over,
  });
  const callbackUrl = 'https://desk--pr-7.global.substrat.run/api/auth/callback';

  it('prints the control plane’s note for a wired login, unmarked, and every carried-over note', () => {
    const lines = formatPreviewLogin(
      created({
        auth: { status: 'wired', callbackUrl, issuer: 'https://auth.acme.test', clientId: 'c1', note: 'Sign-in: wired at auth.acme.test' },
        notes: ['Settings: not carried over'],
      }),
    );
    expect(lines).toEqual(['  Sign-in: wired at auth.acme.test', '  Settings: not carried over']);
  });

  it.each(['unregistered', 'ambiguous', 'unknown'] as const)('marks %s with a warning', (status) => {
    const lines = formatPreviewLogin(created({ auth: { status, callbackUrl, note: `Sign-in: ${status}, register ${callbackUrl}` } }));
    expect(lines[0]).toMatch(/^ {2}⚠ Sign-in:/);
    expect(lines[0]).toContain(callbackUrl);
  });

  it('a control plane that predates it still gets a line naming the callback — never nothing', () => {
    const lines = formatPreviewLogin(created());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('predates preview logins');
    expect(lines[0]).toContain(callbackUrl);
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
    // Absent optionals are omitted, not sent as undefined. `async`: this client takes a 202 (#2450).
    expect(calls[0]!.body).toEqual({ tag: 'pr-7', versionId: '01J', ttlHours: 72, async: true });
  });

  it('sends empty:true for a clean-room preview (#509 (b))', async () => {
    const { calls } = stub(() => ({
      status: 201,
      body: { scopeId: 'S1', hostname: 'h--pr-1.x', url: 'https://h--pr-1.x', versionId: '01J', reused: false },
    }));
    await createPreview({ ...base, tag: 'pr-1', versionId: '01J', empty: true });
    // No sourceScopeId when clean-room; `empty` rides as an explicit true.
    expect(calls[0]!.body).toEqual({ tag: 'pr-1', versionId: '01J', empty: true, async: true });
  });

  describe('a copy that runs in the background (#2450 step 2)', () => {
    const created = { scopeId: 'S1', hostname: 'h--pr-9.x', url: 'https://h--pr-9.x', versionId: '01J', reused: false };
    const copying = (pages: number, attempt = 1) =>
      ({ status: 202, body: { copying: true, scopeId: 'S1', versionId: '01J', progress: { pages, rows: pages * 10, attempt }, retryAfter: 5 } });

    it('calls again on each 202, waiting as told and printing progress, until the preview is ready', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answers = [copying(1), copying(4, 2), { status: 201, body: created }];
      const { calls } = stub(() => answers.shift()!);
      const waits: number[] = [];
      const out = await createPreview({ ...base, tag: 'pr-9', versionId: '01J', sleep: async (ms) => void waits.push(ms) });
      expect(out).toEqual(created);
      expect(calls).toHaveLength(3);
      expect(waits).toEqual([5_000, 5_000]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringMatching(/copying the preview's data \(1 pages, 10 rows so far\)/),
        expect.stringMatching(/4 pages, 40 rows so far, attempt 2: the source changed/),
      ]);
      warn.mockRestore();
    });

    it("polls only after a 202 naming this create's own copy; after one naming another push's, it may start its own", async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // An older push's copy is being finished, then this push's own copy runs, then it is done.
      const theirs = { status: 202, body: { ...copying(3).body, versionId: '01H' } };
      const answers = [theirs, copying(1), copying(2), { status: 201, body: created }];
      const { calls } = stub(() => answers.shift()!);
      await createPreview({ ...base, tag: 'pr-9', versionId: '01J', sleep: async () => {} });
      expect(calls.map((c) => (c.body as { poll?: boolean }).poll)).toEqual([undefined, undefined, true, true]);
    });

    it('a copy that failed ends the wait with its sentence, after the one call that read it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failed = 'the background copy failed with 504: the copy of scope S1 ran past its 360 min limit; nothing was moved';
      const answers = [copying(1), { status: 409, body: { type: 'about:blank', title: 'Conflict', status: 409, detail: failed } }];
      const { calls } = stub(() => answers.shift()!);
      await expect(createPreview({ ...base, tag: 'pr-9', versionId: '01J', sleep: async () => {} }))
        .rejects.toThrow(`preview create failed (409): ${failed}`);
      expect(calls).toHaveLength(2);
    });

    it('sends refresh on the first call only: on a later one it would stop the copy', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answers = [copying(1), { status: 201, body: created }];
      const { calls } = stub(() => answers.shift()!);
      await createPreview({ ...base, tag: 'pr-9', versionId: '01J', refresh: true, sleep: async () => {} });
      expect(calls.map((c) => (c.body as { refresh?: boolean }).refresh)).toEqual([true, undefined]);
    });

    it('gives up after its wait, saying a new run is a new push whose copy starts over', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stub(() => copying(2));
      // `preview create` pushes first, and a push never reuses a version, so a rerun cannot pick
      // this copy up: the route replaces it with the newer push's own.
      await expect(createPreview({ ...base, tag: 'pr-9', versionId: '01J', waitMs: 0, sleep: async () => {} }))
        .rejects.toThrow(/still being copied.*Running this command again pushes a new version, whose copy starts over and replaces this one/);
    });
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

describe('preview create retries a transient platform fault (#1918)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const args = {
    controlPlaneUrl: 'https://cp.example/api',
    header: { 'x-service-token': 't' },
    slug: 'helpdesk',
    tag: 'pr-7',
    versionId: '01J',
  };
  const ok = { scopeId: 'S1', hostname: 'h--pr-7.x', url: 'https://h--pr-7.x', versionId: '01J', reused: false };
  const fault = (ref: string) =>
    new Response(`internal error; reference = ${ref}`, { status: 502 });
  /** Answers from a script, one response per call; records each request body. */
  const script = (answers: Array<() => Response>) => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
      bodies.push(init.body ? JSON.parse(init.body as string) : null);
      return answers[Math.min(bodies.length, answers.length) - 1]!();
    }) as unknown as typeof fetch;
    return bodies;
  };
  const run = async <T>(p: Promise<T>): Promise<T> => {
    const settled = p.then(
      (v) => ({ v }),
      (e) => ({ e }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await settled;
    if ('e' in r) throw r.e;
    return r.v;
  };

  it('a 502 then success succeeds, saying so with the reference, and re-sends the same tag', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = script([() => fault('abc123'), () => Response.json(ok, { status: 201 })]);
    const out = await run(createPreview(args));
    expect(out.scopeId).toBe('S1');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).toMatchObject({ tag: 'pr-7', versionId: '01J' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/502.*reference = abc123.*attempt 2 of 3/);
  });

  it('a network error is retried for a delete and a list, which are safe to repeat', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    globalThis.fetch = (async () => {
      if (++n === 1) throw new TypeError('fetch failed');
      return Response.json({ deleted: null });
    }) as unknown as typeof fetch;
    const { slug, controlPlaneUrl, header, tag } = args;
    await expect(run(deletePreview({ slug, controlPlaneUrl, header, tag }))).resolves.toEqual({ deleted: null });
    expect(n).toBe(2);
    n = 0;
    globalThis.fetch = (async () => {
      if (++n === 1) throw new TypeError('fetch failed');
      return Response.json([]);
    }) as unknown as typeof fetch;
    await expect(run(listPreviews({ slug, controlPlaneUrl, header }))).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  /** A response whose headers arrive and whose body stream then drops. */
  const droppedBody = (status = 200) => () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new TypeError('terminated'));
        },
      }),
      { status },
    );

  it('a connection dropped while reading the body is retried for a delete and a list', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { slug, controlPlaneUrl, header, tag } = args;
    let bodies = script([droppedBody(), () => Response.json({ deleted: null })]);
    await expect(run(deletePreview({ slug, controlPlaneUrl, header, tag }))).resolves.toEqual({ deleted: null });
    expect(bodies).toHaveLength(2);
    bodies = script([droppedBody(), () => Response.json([])]);
    await expect(run(listPreviews({ slug, controlPlaneUrl, header }))).resolves.toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a connection dropped while reading the body is sent once for a create', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = script([droppedBody(), () => Response.json(ok, { status: 201 })]);
    await expect(run(createPreview(args))).rejects.toThrow(/terminated/);
    expect(bodies).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a definite refusal keeps its status even if its body drops, and is not retried', async () => {
    vi.useFakeTimers();
    const { slug, controlPlaneUrl, header, tag } = args;
    const bodies = script([droppedBody(404)]);
    await expect(run(deletePreview({ slug, controlPlaneUrl, header, tag }))).rejects.toThrow(/\(404\)/);
    expect(bodies).toHaveLength(1);
  });

  it('a network error on a create is sent once: the handler may already be forking', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(run(createPreview(args))).rejects.toThrow(/fetch failed/);
    expect(n).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('three 502s fail with the infrastructure-fault text and the last reference', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = script([() => fault('r1'), () => fault('r2'), () => fault('r3')]);
    await expect(run(createPreview(args))).rejects.toThrow(/preview create failed \(502\).*reference = r3[\s\S]*Cloudflare-side infrastructure fault/);
    expect(bodies).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toContain('r1');
    expect(String(warn.mock.calls[1]![0])).toContain('r2');
  });

  it.each([502, 504])('a bare %i (no Cloudflare fault reference) is not retried for a create: the handler may still be forking', async (status) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = script([() => new Response('upstream timed out', { status })]);
    await expect(run(createPreview(args))).rejects.toThrow(new RegExp(`\\(${status}\\)`));
    expect(bodies).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a 503 (refused before the handler ran) is retried for a create', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = script([() => new Response('unavailable', { status: 503 }), () => Response.json(ok, { status: 201 })]);
    await expect(run(createPreview(args))).resolves.toMatchObject({ scopeId: 'S1' });
    expect(bodies).toHaveLength(2);
  });

  it('a delete whose first attempt landed but lost its response succeeds on retry: the route answers deleted:null, not 404', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = script([() => new Response('upstream timed out', { status: 502 }), () => Response.json({ deleted: null })]);
    const { slug, controlPlaneUrl, header, tag } = args;
    await expect(run(deletePreview({ slug, controlPlaneUrl, header, tag }))).resolves.toEqual({ deleted: null });
    expect(bodies).toHaveLength(2);
  });

  it('a delete 404 (unknown vertical) is a definite failure, never swallowed as success', async () => {
    vi.useFakeTimers();
    const bodies = script([() => new Response('{"error":"unknown vertical"}', { status: 404 })]);
    const { slug, controlPlaneUrl, header, tag } = args;
    await expect(run(deletePreview({ slug, controlPlaneUrl, header, tag }))).rejects.toThrow(/\(404\)/);
    expect(bodies).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 409, 422, 500, 501])('a %i is a definite answer and is never retried', async (status) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = script([() => new Response('{"error":"no"}', { status })]);
    await expect(run(createPreview(args))).rejects.toThrow(new RegExp(`\\(${status}\\)`));
    expect(bodies).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('prints the in-flight 409 whole: how long until the tag frees, and how to replace it now (#1920)', async () => {
    vi.useFakeTimers();
    // The body `orchestratedPreview` answers when a create for the tag is still being built.
    const error =
      "a create for preview 'pr-1' is in progress (started 2026-09-29T10:00:00.000Z). " +
      'Retry once it finishes; if it died, the tag can be reclaimed in 12 min, ' +
      'or now with refresh (substrat preview create --refresh), which replaces it and stops a ' +
      'create still running: that create then fails';
    const bodies = script([() => new Response(JSON.stringify({ error }), { status: 409 })]);
    const refused = run(createPreview(args));
    await expect(refused).rejects.toThrow(`preview create failed (409): ${error}`);
    // A first attempt refused is someone else's create still running: no guess about a dead one.
    await expect(refused).rejects.not.toThrow(/most likely died/);
    expect(bodies).toHaveLength(1);
  });

  it('a RETRIED create refused as in progress says the earlier attempt died, and how to reclaim now (#1920)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = "a create for preview 'pr-1' is in progress (started 2026-09-29T10:00:00.000Z).";
    const bodies = script([
      () => new Response('', { status: 503 }),
      () => new Response(JSON.stringify({ error }), { status: 409 }),
    ]);
    const refused = run(createPreview(args));
    await expect(refused).rejects.toThrow(`preview create failed (409): ${error}`);
    await expect(refused).rejects.toThrow(/earlier attempt of this create most likely died .*--refresh reclaims the tag now/s);
    expect(bodies).toHaveLength(2);
  });

  it('a retried create refused for any other reason adds nothing', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    script([
      () => new Response('', { status: 503 }),
      () => new Response('{"error":"no prod scope to fork"}', { status: 409 }),
    ]);
    await expect(run(createPreview(args))).rejects.not.toThrow(/most likely died/);
  });

  describe('a poll during a background copy (#2450)', () => {
    const copying = () =>
      Response.json({ copying: true, scopeId: 'S1', versionId: '01J', progress: { pages: 1, rows: 10, attempt: 1 }, retryAfter: 5 }, { status: 202 });
    const dropped = (): Response => {
      throw new TypeError('fetch failed');
    };
    /** As `script`, but an answer may throw, as `fetch` does for a dropped connection. */
    const scriptThrowing = (answers: Array<() => Response>) => {
      const bodies: unknown[] = [];
      globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
        bodies.push(init.body ? JSON.parse(init.body as string) : null);
        return answers[Math.min(bodies.length, answers.length) - 1]!();
      }) as unknown as typeof fetch;
      return bodies;
    };
    const waits: number[] = [];
    const polling = { ...args, sleep: async (ms: number) => void waits.push(ms) };

    it('one that fails as a gateway or the network fails is polled again, and the wait goes on', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      waits.length = 0;
      // A 502 on every try of the second call, then a dropped connection on every try of the third.
      const bodies = scriptThrowing([
        copying,
        () => fault('p1'), () => fault('p2'), () => fault('p3'),
        dropped, dropped, dropped,
        copying,
        () => Response.json(ok, { status: 201 }),
      ]);
      await expect(run(createPreview(polling))).resolves.toEqual(ok);
      expect(bodies).toHaveLength(9);
      // Each failed poll waited the interval the last answer gave, and said so.
      expect(waits).toEqual([5_000, 5_000, 5_000, 5_000]);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /polling the copy failed/.test(l))).toEqual([
        expect.stringMatching(/\(502\); polling again in 5s \(1 of 10\)/),
        expect.stringMatching(/\(network error: fetch failed\); polling again in 5s \(2 of 10\)/),
      ]);
    });

    it('a definite answer to a poll ends the wait at once; the first call is still sent once on a dropped connection', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      let bodies = scriptThrowing([copying, () => Response.json({ error: 'the copy of scope S1 was cancelled' }, { status: 409 })]);
      await expect(run(createPreview(polling))).rejects.toThrow(/\(409\).*cancelled/);
      expect(bodies).toHaveLength(2);
      bodies = scriptThrowing([dropped, copying]);
      await expect(run(createPreview(polling))).rejects.toThrow(/fetch failed/);
      expect(bodies).toHaveLength(1);
    });

    it('a control plane that stays unreachable ends the wait after its last allowed poll', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bodies = scriptThrowing([copying, () => fault('down')]);
      const settled = createPreview(polling).then((v) => ({ v }), (e: unknown) => ({ e }));
      await vi.advanceTimersByTimeAsync(120_000);
      const r = await settled;
      expect('e' in r && String(r.e)).toMatch(/\(502\)/);
      // The first call, then eleven polls of three tries each: ten ridden out, the eleventh thrown.
      expect(bodies).toHaveLength(1 + 11 * 3);
    });
  });
});
