import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWfpUploader, createWfpModulesFetcher } from '../src/wfp.js';
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

async function metadataOf(injectSecrets: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  let body: FormData | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: { body?: FormData }) => {
      body = init.body;
      return new Response('{}', { status: 200 });
    }),
  );
  const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok', injectSecrets });
  await upload('callout-01k', bundle);
  const meta = await (body!.get('metadata') as File).text();
  return JSON.parse(meta) as Record<string, unknown>;
}

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
