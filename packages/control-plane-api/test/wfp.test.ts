import { describe, it, expect, vi, afterEach } from 'vitest';
import { assetHash } from '@substrat-run/contracts';
import { createWfpUploader, createWfpModulesFetcher, clip } from '../src/wfp.js';
import { upstreamStatusOf } from '../src/deploy.js';
import type { VerticalBundle } from '../src/deploy.js';

/**
 * The WfP uploader's one job worth testing without a real account: the multipart
 * metadata it builds — specifically that platform-owned secrets are injected as
 * `secret_text` bindings (so a pushed vertical can verify inbound platform/router
 * calls) alongside the vertical's own bindings, and that empty ones are skipped.
 */
const bundle: VerticalBundle = {
  entry: 'worker.js',
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  doClasses: ['ScopeDO'],
  bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
  modules: [{ name: 'worker.js', content: new Uint8Array([1, 2, 3]), contentType: 'application/javascript+module' }],
};

afterEach(() => vi.unstubAllGlobals());

async function metadataOf(
  injectSecrets: Record<string, string | undefined>,
  extra: { traceSampling?: number } = {},
): Promise<Record<string, unknown>> {
  let body: FormData | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: { body?: FormData }) => {
      body = init.body;
      return new Response('{}', { status: 200 });
    }),
  );
  const upload = createWfpUploader({
    accountId: 'acct',
    namespace: 'ns',
    apiToken: 'tok',
    injectSecrets,
    ...extra,
  });
  await upload('callout-01k', bundle);
  const meta = await (body!.get('metadata') as File).text();
  return JSON.parse(meta) as Record<string, unknown>;
}

describe('createWfpUploader — tracing (#858)', () => {
  it('declares no traces block by default, so a deploy changes nothing prod emits', async () => {
    const meta = await metadataOf({});
    // `enabled: true` must survive — it is what makes builder logs queryable at all.
    expect(meta['observability']).toEqual({ enabled: true });
  });

  it('declares traces at the given head sampling rate when the platform sets one', async () => {
    const meta = await metadataOf({}, { traceSampling: 1 });
    expect(meta['observability']).toEqual({
      enabled: true,
      traces: { enabled: true, head_sampling_rate: 1 },
    });
  });

  it('treats 0 as "declared, sampling none" — not as absent', async () => {
    // The distinction is the whole reason the option is a rate and not a boolean: a
    // declared-but-unsampled script is configured, an undeclared one never was, and
    // an experiment that concludes from missing spans has to tell them apart.
    const meta = await metadataOf({}, { traceSampling: 0 });
    expect(meta['observability']).toEqual({
      enabled: true,
      traces: { enabled: true, head_sampling_rate: 0 },
    });
  });
});

describe('createWfpUploader — secret injection', () => {
  it('injects platform secrets as secret_text bindings, keeping the vertical’s own', async () => {
    const meta = await metadataOf({ PLATFORM_SECRET: 'p-val', ROUTER_SECRET: 'r-val' });
    const bindings = meta['bindings'] as { type: string; name: string; text?: string }[];
    expect(bindings).toContainEqual({ type: 'secret_text', name: 'PLATFORM_SECRET', text: 'p-val' });
    expect(bindings).toContainEqual({ type: 'secret_text', name: 'ROUTER_SECRET', text: 'r-val' });
    // The vertical's own binding survives, and the compat flags carry through.
    expect(bindings).toContainEqual({ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' });
    expect(meta['compatibility_flags']).toEqual(['nodejs_compat']);
  });

  it('skips a secret whose value is unset (a half-configured platform)', async () => {
    const meta = await metadataOf({ PLATFORM_SECRET: 'p-val', ROUTER_SECRET: undefined });
    const secrets = (meta['bindings'] as { type: string; name: string }[]).filter((b) => b.type === 'secret_text');
    expect(secrets.map((s) => s.name)).toEqual(['PLATFORM_SECRET']);
  });
});

/**
 * The in-place update mode (#286): re-uploading the SERVING script must keep the
 * secrets already on it (keep_bindings) and may only declare DO classes the script
 * does not already have — re-declaring a live class is a Cloudflare upload error,
 * and an unchanged class set sends no migrations block at all.
 */
describe('createWfpUploader — in-place updates (#286)', () => {
  async function inPlaceMetadataOf(
    doClasses: string[],
    inPlace: { priorDoClasses: string[]; priorMigrationTag: string },
  ): Promise<Record<string, unknown>> {
    let body: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body?: FormData }) => {
        body = init.body;
        return new Response('{}', { status: 200 });
      }),
    );
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    await upload('callout', { ...bundle, doClasses }, inPlace);
    return JSON.parse(await (body!.get('metadata') as File).text()) as Record<string, unknown>;
  }

  it('a fresh upload declares every class under v1 and inherits nothing', async () => {
    let body: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body?: FormData }) => {
        body = init.body;
        return new Response('{}', { status: 200 });
      }),
    );
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    await upload('callout', bundle);
    const meta = JSON.parse(await (body!.get('metadata') as File).text()) as Record<string, unknown>;
    expect(meta['migrations']).toEqual({ new_tag: 'v1', new_sqlite_classes: ['ScopeDO'] });
    expect(meta['keep_bindings']).toBeUndefined();
  });

  it('an unchanged class set sends NO migrations block and keeps existing secrets', async () => {
    const meta = await inPlaceMetadataOf(['ScopeDO'], { priorDoClasses: ['ScopeDO'], priorMigrationTag: 'v1' });
    expect(meta['migrations']).toBeUndefined();
    expect(meta['keep_bindings']).toEqual(['secret_text', 'secret_key']);
  });

  it('a NEW class rides as the delta under a bumped tag', async () => {
    const meta = await inPlaceMetadataOf(['ScopeDO', 'TimerDO'], { priorDoClasses: ['ScopeDO'], priorMigrationTag: 'v1' });
    expect(meta['migrations']).toEqual({ old_tag: 'v1', new_tag: 'v2', new_sqlite_classes: ['TimerDO'] });
  });
});

/**
 * The archive script is the platform's bundle store (#286): promote and backout read
 * the built modules back through /content. Cloudflare answers multipart for a
 * multi-module script and a bare body (entrypoint in `cf-entrypoint`) for a single
 * module — both must parse with web-standard APIs only.
 */
describe('createWfpModulesFetcher', () => {
  it('parses a multipart multi-module response', async () => {
    const form = new FormData();
    form.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    form.set('lib.js', new Blob(['export const x = 1'], { type: 'application/javascript+module' }), 'lib.js');
    // Round-trip through Response so the boundary lands in the content-type header.
    const req = new Response(form);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(req.body, { headers: { 'content-type': req.headers.get('content-type')! } })));
    const fetchModules = createWfpModulesFetcher({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    const modules = await fetchModules('callout-01k');
    expect(modules.map((m) => m.name).sort()).toEqual(['lib.js', 'worker.js']);
    expect(new TextDecoder().decode(modules.find((m) => m.name === 'worker.js')!.content)).toBe('export default {}');
  });

  it('parses multipart parts that carry no filename (Cloudflare read-back shape, #308)', async () => {
    // Cloudflare's GET /content is not an echo of the PUT: a module part may arrive with
    // `Content-Disposition: form-data; name="worker.js"` and NO `filename=`, which the
    // web-standard FormData parser exposes as a string, not a File. Build the body by hand
    // (FormData's third arg would force a filename) to reproduce that exact wire shape.
    const boundary = '----wfp-test';
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="worker.js"\r\n` +
      `Content-Type: application/javascript+module\r\n\r\n` +
      `export default {}\r\n` +
      `--${boundary}--\r\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })),
    );
    const fetchModules = createWfpModulesFetcher({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    const modules = await fetchModules('callout-01k');
    expect(modules).toHaveLength(1);
    expect(modules[0]!.name).toBe('worker.js');
    expect(new TextDecoder().decode(modules[0]!.content)).toBe('export default {}');
  });

  it('parses a single-module response via cf-entrypoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('export default {}', {
          headers: { 'content-type': 'application/javascript+module', 'cf-entrypoint': 'worker.js' },
        }),
      ),
    );
    const fetchModules = createWfpModulesFetcher({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    const modules = await fetchModules('callout-01k');
    expect(modules).toHaveLength(1);
    expect(modules[0]!.name).toBe('worker.js');
  });
});

/**
 * A failed upload must reach the caller diagnosable (#307): the upstream CF error body is
 * carried through — clipped only WITH a marker, never mid-token — and the throw carries the
 * upstream CF status so the deploy handler can answer a bad bundle as a client error, not a
 * blanket 502 that reads as a platform outage.
 */
describe('createWfpUploader — upload failure', () => {
  async function uploadWith(status: number, body: string): Promise<unknown> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    return upload('callout-01k', bundle).then(
      () => undefined,
      (e) => e,
    );
  }

  it('carries the upstream CF status so the caller can tell a bad bundle from a platform fault', async () => {
    const badBundle = await uploadWith(400, '{"errors":[{"code":10021,"message":"Uncaught Error"}]}');
    expect(upstreamStatusOf(badBundle)).toBe(400);
    const platform = await uploadWith(503, 'upstream unavailable');
    expect(upstreamStatusOf(platform)).toBe(503);
  });

  it('marks a clipped body explicitly instead of ending mid-token', async () => {
    // A 3000-char CF error list (the shape that ended '…eka/set-budg' with no marker).
    const long = 'op/' + 'x'.repeat(3000);
    const e = (await uploadWith(400, long)) as Error;
    expect(e.message).toContain('… [truncated, ');
    expect(e.message).toMatch(/\[truncated, \d+ chars omitted\]$/);
    // The default 2000-char cap, applied to the body (not the whole message).
    expect(e.message).toContain(`[truncated, ${long.length - 2000} chars omitted]`);
  });

  it('leaves a short body whole', async () => {
    const e = (await uploadWith(400, 'compatibility flag nodejs_compat required')) as Error;
    expect(e.message).toContain('compatibility flag nodejs_compat required');
    expect(e.message).not.toContain('truncated');
  });
});

/**
 * Static assets (#340). Assets are not a binding — they ride their own three-step upload
 * session before the script PUT, which then names only the completion token. What is worth
 * pinning: the session runs at all (and only when there is something to upload), the bytes
 * go up base64 keyed by hash and typed with what they'll be SERVED as, and the promote case
 * — a re-serve carrying no bytes — either rides dedup or refuses loudly.
 */
describe('createWfpUploader — static assets (#340)', () => {
  const html = new TextEncoder().encode('<!doctype html>');
  const withAssets = (files: VerticalBundle['assets']): VerticalBundle => ({ ...bundle, assets: files });

  /** Drive an upload against a scripted sequence of CF responses; return every request made. */
  async function driveUpload(
    b: VerticalBundle,
    responses: (url: string) => Response,
  ): Promise<{ url: string; init: { body?: FormData | string; headers?: Record<string, string> } }[]> {
    const calls: { url: string; init: { body?: FormData | string; headers?: Record<string, string> } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: { body?: FormData | string; headers?: Record<string, string> }) => {
        calls.push({ url: String(url), init });
        return responses(String(url));
      }),
    );
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    await upload('callout-01k', b);
    return calls;
  }

  const sessionWith = (buckets: string[][]) =>
    new Response(JSON.stringify({ result: { jwt: 'session-jwt', buckets } }), { status: 200 });

  it('runs session → bucket upload → script PUT, and names the completion jwt', async () => {
    const calls = await driveUpload(
      withAssets({
        notFoundHandling: 'single-page-application',
        runWorkerFirst: ['/api/*'],
        files: [{ path: '/index.html', hash: 'a'.repeat(32), size: html.byteLength, contentType: 'text/html', content: html }],
      }),
      (url) =>
        url.includes('assets-upload-session')
          ? sessionWith([['a'.repeat(32)]])
          : url.includes('/workers/assets/upload')
            ? new Response(JSON.stringify({ result: { jwt: 'completion-jwt' } }), { status: 200 })
            : new Response('{}', { status: 200 }),
    );

    // 1. the session carries the path → {hash,size} manifest…
    expect(calls[0]!.url).toContain('/scripts/callout-01k/assets-upload-session');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      manifest: { '/index.html': { hash: 'a'.repeat(32), size: html.byteLength } },
    });
    // 2. …the bucket goes up base64, keyed by hash, authorised with the SESSION jwt, and
    //    typed with what the file will be served as (CF replays that Content-Type).
    expect(calls[1]!.url).toContain('/workers/assets/upload?base64=true');
    expect(calls[1]!.init.headers).toMatchObject({ authorization: 'Bearer session-jwt' });
    const part = (calls[1]!.init.body as FormData).get('a'.repeat(32)) as File;
    expect(part.type).toBe('text/html');
    expect(await part.text()).toBe(Buffer.from('<!doctype html>').toString('base64'));
    // 3. …and the script PUT names the COMPLETION token plus the routing config.
    const meta = JSON.parse(await ((calls[2]!.init.body as FormData).get('metadata') as File).text());
    expect(meta.assets).toEqual({
      jwt: 'completion-jwt',
      config: {
        not_found_handling: 'single-page-application',
        // The vertical's list, plus the platform's own — see the next case for why.
        run_worker_first: ['/api/*', '/.well-known/*'],
      },
    });
  });

  /**
   * The bug this exists to stop recurring (#1182 in production).
   *
   * `mountOperations` mounts `/.well-known/oauth-protected-resource/*` because RFC 9728
   * requires the document at the origin root. ticket0's manifest listed `/api/*` and not
   * that, so Cloudflare's asset layer answered it from the edge with `index.html` and the
   * worker was never invoked — a correctly registered route, unreachable, with no lint or
   * test able to see it because it fails one layer below the code.
   *
   * So the platform routes `.well-known` worker-first whatever the vertical declared. A
   * vertical that mounts nothing there is unaffected: its own catch-all answers 404,
   * which is what the asset layer would have said.
   */
  it('routes .well-known worker-first even when the vertical did not ask', async () => {
    const calls = await driveUpload(
      withAssets({
        notFoundHandling: 'single-page-application',
        runWorkerFirst: ['/api/*'],
        files: [{ path: '/index.html', hash: 'b'.repeat(32), size: 15, contentType: 'text/html' }],
      }),
      (url) => (url.includes('assets-upload-session') ? sessionWith([]) : new Response('{}', { status: 200 })),
    );
    const meta = JSON.parse(await ((calls.at(-1)!.init.body as FormData).get('metadata') as File).text());
    expect(meta.assets.config.run_worker_first).toContain('/.well-known/*');
  });

  it('adds it once when the vertical already listed it', async () => {
    const calls = await driveUpload(
      withAssets({
        notFoundHandling: 'single-page-application',
        runWorkerFirst: ['/.well-known/*', '/api/*'],
        files: [{ path: '/index.html', hash: 'b'.repeat(32), size: 15, contentType: 'text/html' }],
      }),
      (url) => (url.includes('assets-upload-session') ? sessionWith([]) : new Response('{}', { status: 200 })),
    );
    const meta = JSON.parse(await ((calls.at(-1)!.init.body as FormData).get('metadata') as File).text());
    // Deduplicated, and the vertical's own order kept — a manifest that already named it
    // produces byte-identical config rather than a second entry.
    expect(meta.assets.config.run_worker_first).toEqual(['/.well-known/*', '/api/*']);
  });

  /** `true` already routes everything worker-first; there is nothing to add. */
  it('leaves a blanket worker-first declaration alone', async () => {
    const calls = await driveUpload(
      withAssets({
        runWorkerFirst: true,
        files: [{ path: '/index.html', hash: 'b'.repeat(32), size: 15, contentType: 'text/html' }],
      }),
      (url) => (url.includes('assets-upload-session') ? sessionWith([]) : new Response('{}', { status: 200 })),
    );
    const meta = JSON.parse(await ((calls.at(-1)!.init.body as FormData).get('metadata') as File).text());
    expect(meta.assets.config.run_worker_first).toBe(true);
  });

  it('empty buckets means every byte is already stored — the session jwt completes it', async () => {
    // This is the promote path (#286): a re-serve declares the retained manifest and carries
    // no bytes, and content-addressed dedup is what makes that work.
    const calls = await driveUpload(
      withAssets({ files: [{ path: '/index.html', hash: 'b'.repeat(32), size: 15, contentType: 'text/html' }] }),
      (url) => (url.includes('assets-upload-session') ? sessionWith([]) : new Response('{}', { status: 200 })),
    );
    expect(calls).toHaveLength(2); // session, then the script PUT — no bucket upload
    const meta = JSON.parse(await ((calls[1]!.init.body as FormData).get('metadata') as File).text());
    expect(meta.assets.jwt).toBe('session-jwt');
  });

  it('REFUSES a re-serve whose bytes the runtime no longer holds, naming the remedy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('assets-upload-session') ? sessionWith([['c'.repeat(32)]]) : new Response('{}', { status: 200 }),
      ),
    );
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    // A version deployed with an incomplete asset set would look successful and serve a
    // half-broken page; the refusal is the point.
    await expect(
      upload('callout-01k', withAssets({ files: [{ path: '/app.js', hash: 'c'.repeat(32), size: 9, contentType: 'text/javascript' }] })),
    ).rejects.toThrow(/push the version again/);
  });

  it('recovers a missing asset’s bytes on demand and uploads them (#578)', async () => {
    // The dedupe a byteless re-serve rides is per SCRIPT, not namespace-wide: the stable
    // script's first serve of new content always reports the hash missing, even though the
    // push uploaded those exact bytes to the version's archive script moments earlier. The
    // recovery hook turns that refusal into a read-back + upload.
    const content = new TextEncoder().encode('<!doctype html>');
    const hash = await assetHash(content, '/index.html');
    const recover = vi.fn(async () => content);
    const calls = await driveUpload(
      withAssets({
        files: [{ path: '/index.html', hash, size: content.byteLength, contentType: 'text/html' }],
        recoverContent: recover,
      }),
      (url) =>
        url.includes('assets-upload-session')
          ? sessionWith([[hash]])
          : url.includes('/workers/assets/upload')
            ? new Response(JSON.stringify({ result: { jwt: 'completion-jwt' } }), { status: 200 })
            : new Response('{}', { status: 200 }),
    );
    expect(recover).toHaveBeenCalledWith({ path: '/index.html', hash });
    const part = (calls[1]!.init.body as FormData).get(hash) as File;
    expect(await part.text()).toBe(Buffer.from('<!doctype html>').toString('base64'));
    const meta = JSON.parse(await ((calls[2]!.init.body as FormData).get('metadata') as File).text());
    expect(meta.assets.jwt).toBe('completion-jwt');
  });

  it('REFUSES recovered bytes that do not hash to the manifest’s content-address', async () => {
    // The asset store is shared and content-addressed: bytes stored under a key they do
    // not have could decide what a DIFFERENT vertical's identical-hash asset serves (D-44).
    const hash = await assetHash(new TextEncoder().encode('the real bytes'), '/app.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('assets-upload-session') ? sessionWith([[hash]]) : new Response('{}', { status: 200 }),
      ),
    );
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    await expect(
      upload(
        'callout-01k',
        withAssets({
          files: [{ path: '/app.js', hash, size: 14, contentType: 'text/javascript' }],
          recoverContent: async () => new TextEncoder().encode('tampered bytes'),
        }),
      ),
    ).rejects.toThrow(/content-address they do not have/);
  });

  it('refuses honestly when the archive script gives no bytes back either', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('assets-upload-session') ? sessionWith([['e'.repeat(32)]]) : new Response('{}', { status: 200 }),
      ),
    );
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    await expect(
      upload(
        'callout-01k',
        withAssets({
          files: [{ path: '/gone.js', hash: 'e'.repeat(32), size: 1, contentType: 'text/javascript' }],
          recoverContent: async () => undefined,
        }),
      ),
    ).rejects.toThrow(/archive script gave none back/);
  });

  it('a bundle with no assets runs no session and sends no assets block', async () => {
    const calls = await driveUpload(bundle, () => new Response('{}', { status: 200 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/scripts/callout-01k');
    const meta = JSON.parse(await ((calls[0]!.init.body as FormData).get('metadata') as File).text());
    expect(meta.assets).toBeUndefined();
  });

  it('carries the upstream status when the session itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad manifest', { status: 400 })));
    const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });
    const e = await upload('callout-01k', withAssets({ files: [{ path: '/a.js', hash: 'd'.repeat(32), size: 1, contentType: 'text/javascript', content: new Uint8Array([1]) }] })).catch((err) => err);
    expect(upstreamStatusOf(e)).toBe(400);
  });
});

describe('clip', () => {
  it('returns a within-cap body unchanged', () => {
    expect(clip('short', 100)).toBe('short');
    expect(clip('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  it('appends an explicit marker with the omitted count when over the cap', () => {
    expect(clip('x'.repeat(105), 100)).toBe(`${'x'.repeat(100)} … [truncated, 5 chars omitted]`);
  });
});
