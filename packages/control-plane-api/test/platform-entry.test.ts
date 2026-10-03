import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invocationLog } from '@substrat-run/vertical-host';
import { createWfpUploader } from '../src/wfp.js';
import type { VerticalBundle } from '../src/deploy.js';
import { PLATFORM_ENTRY_MODULE, platformEntrySkipReason, withPlatformEntry } from '../src/platform-entry.js';

/**
 * The platform's entry (#1893): what the uploader puts in front of a vertical's bundle,
 * and — run for real, from the generated source — what that entry does to a request.
 */
afterEach(() => vi.unstubAllGlobals());

const js = (name: string, text: string) => ({
  name,
  content: new TextEncoder().encode(text),
  contentType: 'application/javascript+module',
});
const textOf = (m: { content: Uint8Array }) => new TextDecoder().decode(m.content);

const bundle = (modules = [js('worker.js', 'export default { fetch() { return new Response("ok") } }')]) => ({
  entry: 'worker.js',
  modules,
});

describe('withPlatformEntry (#1893)', () => {
  it('names the platform entry as the main module, importing the vertical’s own', () => {
    const out = withPlatformEntry(bundle());
    expect(out.entry).toBe(PLATFORM_ENTRY_MODULE);
    expect(out.modules.map((m) => m.name)).toEqual([PLATFORM_ENTRY_MODULE, 'worker.js']);
    const entry = textOf(out.modules[0]!);
    expect(entry).toContain('"./worker.js"');
    expect(entry).not.toContain('__SUBSTRAT_VERTICAL_ENTRY__');
  });

  it('points at an entry in a subdirectory by its path from the script root', () => {
    const out = withPlatformEntry({ entry: 'src/worker.js', modules: [js('src/worker.js', 'export default {}')] });
    expect(textOf(out.modules[0]!)).toContain('"./src/worker.js"');
  });

  it('replaces a stale platform entry a re-served archive carries, never stacks one', () => {
    // Promote and backout re-upload what the archive script holds, which already has an
    // entry of ours in it — while the manifest still names the vertical's own module.
    const archived = bundle([js(PLATFORM_ENTRY_MODULE, 'export default "an older platform entry"'), ...bundle().modules]);
    const out = withPlatformEntry(archived);
    expect(out.modules.filter((m) => m.name === PLATFORM_ENTRY_MODULE)).toHaveLength(1);
    expect(textOf(out.modules[0]!)).toBe(textOf(withPlatformEntry(bundle()).modules[0]!));
  });

  it('wraps a bundle that mounts the middleware with a current kernel — it steps aside', () => {
    const current = js('worker.js', 'const s = Symbol.for("substrat.invocation-stamp"); console.log(JSON.stringify({substrat:"invocation"}))');
    expect(platformEntrySkipReason(bundle([current]))).toBeUndefined();
  });

  it('leaves a bundle alone that writes the line with a kernel older than the shared stamp', () => {
    // Wrapping it would log every request twice: that kernel does not know to step aside.
    const old = bundle([js('worker.js', 'console.log(JSON.stringify({ substrat: "invocation", status }))')]);
    expect(platformEntrySkipReason(old)).toMatch(/predates/);
    expect(withPlatformEntry(old)).toBe(old);
  });

  it('does not read the fault line as the invocation line', () => {
    const faultOnly = bundle([js('worker.js', 'console.log(JSON.stringify({substrat:"invocation-log-fault"}))')]);
    expect(platformEntrySkipReason(faultOnly)).toBeUndefined();
  });

  it('leaves a bundle alone whose entry it cannot find', () => {
    const odd = { entry: 'missing.js', modules: bundle().modules };
    expect(withPlatformEntry(odd)).toBe(odd);
  });
});

describe('the uploader puts it in front (#1893)', () => {
  it('uploads the entry module and names it as main_module', async () => {
    let body: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body?: FormData }) => {
        body = init.body;
        return new Response('{}', { status: 200 });
      }),
    );
    const full: VerticalBundle = { ...bundle(), compatibilityDate: '2025-01-01', compatibilityFlags: [], doClasses: [], bindings: [] };
    await createWfpUploader({ accountId: 'a', namespace: 'n', apiToken: 't' })('acme-01k', full);
    const meta = JSON.parse(await (body!.get('metadata') as File).text()) as Record<string, unknown>;
    expect(meta['main_module']).toBe(PLATFORM_ENTRY_MODULE);
    expect(body!.get(PLATFORM_ENTRY_MODULE)).toBeInstanceOf(File);
    expect(body!.get('worker.js')).toBeInstanceOf(File);
  });
});

/** Run the generated entry against a vertical module, from files on disk. */
async function load(vertical: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-entry-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const out = withPlatformEntry(bundle([js('worker.js', vertical)]));
  for (const m of out.modules) writeFileSync(join(dir, m.name), m.content);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return (await import(pathToFileURL(join(dir, PLATFORM_ENTRY_MODULE)).href)) as Record<string, any>;
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRET = 'router-sekret';
const TENANT = '01JZ0000000000000000TEN001';
const SCOPE = '01JZ0000000000000000SCP001';
const routed = () =>
  new Request('https://acme.example/api/things', {
    headers: {
      'x-substrat-router': SECRET,
      'x-substrat-tenant': TENANT,
      'x-substrat-scope': SCOPE,
      'x-substrat-vertical': 'acme/widgets',
      'x-substrat-surface': 'app',
    },
  });

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((first: unknown) => {
    try {
      const parsed = JSON.parse(String(first));
      if (parsed?.substrat === 'invocation') lines.push(parsed);
    } catch {
      /* not ours */
    }
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('the generated entry, run (#1893)', () => {
  it('stamps a vertical that mounts nothing, and passes its other exports through', async () => {
    const mod = await load(
      'export class ScopeDO {}\nexport default { fetch: () => new Response("ok", { status: 201 }), scheduled: () => "ran" };',
    );
    expect(typeof mod['ScopeDO']).toBe('function');
    const cap = capture();
    try {
      const res = await mod['default'].fetch(routed(), { ROUTER_SECRET: SECRET }, {});
      expect(res.status).toBe(201);
      expect(await mod['default'].scheduled()).toBe('ran');
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ tenantId: TENANT, scopeId: SCOPE, status: 201, level: 'info' });
  });

  it('writes nothing for a request the router did not sign', async () => {
    const mod = await load('export default { fetch: () => new Response("ok") };');
    const cap = capture();
    try {
      await mod['default'].fetch(new Request('https://acme.example/'), { ROUTER_SECRET: SECRET }, {});
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(0);
  });

  it('logs once when the vertical mounts its own copy of the middleware too', async () => {
    // The vertical's middleware is THIS suite's kernel — a different module instance from
    // the copy bundled into the entry — so the only thing they share is the registry.
    const mounted = invocationLog<{ ROUTER_SECRET: string }>({ routerSecret: (env) => env.ROUTER_SECRET });
    (globalThis as Record<string, unknown>)['__verticalMiddleware'] = mounted;
    const mod = await load(`
      const mw = globalThis.__verticalMiddleware;
      export default {
        async fetch(request, env) {
          const vars = new Map();
          const c = { req: { raw: request, method: request.method, url: request.url, header: (n) => request.headers.get(n) },
            env, set: (k, v) => vars.set(k, v), get: (k) => vars.get(k), res: undefined };
          await mw(c, async () => { c.res = new Response('ok', { status: 202 }); });
          return c.res;
        },
      };`);
    const cap = capture();
    try {
      const res = await mod['default'].fetch(routed(), { ROUTER_SECRET: SECRET }, {});
      expect(res.status).toBe(202);
    } finally {
      cap.restore();
      delete (globalThis as Record<string, unknown>)['__verticalMiddleware'];
    }
    expect(cap.lines).toHaveLength(1);
  });

  it('hands back a class entrypoint, or no default at all, untouched', async () => {
    const cls = await load('export default class Worker {}');
    expect(typeof cls['default']).toBe('function');
    const none = await load('export const x = 1;');
    expect(none['default']).toBeUndefined();
    expect(none['x']).toBe(1);
  });
});
