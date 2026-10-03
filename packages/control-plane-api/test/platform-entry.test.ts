import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invocationLog } from '@substrat-run/vertical-host';
import { createWfpUploader } from '../src/wfp.js';
import { DeployUploadError, type VerticalBundle } from '../src/deploy.js';
import {
  PLATFORM_ENTRY_MODULE,
  PLATFORM_SWEEPER_BINDING,
  PLATFORM_SWEEPER_CLASS,
  PLATFORM_SWEEPER_MODULE,
  PLATFORM_SWEEPER_VAR,
  platformEntrySkipReason,
  platformSweeperPlan,
  withPlatformEntry,
} from '../src/platform-entry.js';

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

/**
 * The scope sweeper the uploader supplies (#1902): to a version that declares schedules and
 * brings none, decided from the push's DECLARATION — `sweeperClasses`, or the conventional
 * names when an older CLI sent none — and never from the bundle's bytes.
 */
describe('the platform supplies the scope sweeper (#1902)', () => {
  const scope = { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' };
  const ownSweeper = { type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'SweeperDO' };
  const vertical = (facts: Partial<VerticalBundle>) => ({ ...bundle(), doClasses: ['ScopeDO'], bindings: [scope], ...facts });
  const refused = (facts: Partial<VerticalBundle>) => {
    try {
      platformSweeperPlan(vertical(facts));
    } catch (e) {
      expect(e).toBeInstanceOf(DeployUploadError);
      expect((e as DeployUploadError).upstreamStatus).toBe(422);
      return (e as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('supplies one when the push declared schedules and no sweeper of its own', () => {
    const out = withPlatformEntry(vertical({ declaresSchedules: true, sweeperClasses: [] }));
    expect(out.modules.map((m) => m.name)).toEqual([PLATFORM_ENTRY_MODULE, PLATFORM_SWEEPER_MODULE, 'worker.js']);
    expect(textOf(out.modules[0]!)).toContain(`export { SweeperDO } from "./${PLATFORM_SWEEPER_MODULE}"`);
    expect(textOf(out.modules[1]!)).toContain('export {\n  SweeperDO\n}');
    expect(out.doClasses).toEqual(['ScopeDO', PLATFORM_SWEEPER_CLASS]);
    expect(out.bindings).toEqual([
      scope,
      { type: 'durable_object_namespace', name: PLATFORM_SWEEPER_BINDING, class_name: PLATFORM_SWEEPER_CLASS },
      { type: 'plain_text', name: PLATFORM_SWEEPER_VAR, text: PLATFORM_SWEEPER_BINDING },
    ]);
  });

  it('gives a version with no schedules none, whatever else it declares', () => {
    for (const sweeperClasses of [[], undefined]) {
      const out = withPlatformEntry(vertical({ sweeperClasses }));
      expect(out.modules.map((m) => m.name)).toEqual([PLATFORM_ENTRY_MODULE, 'worker.js']);
      expect(out.doClasses).toEqual(['ScopeDO']);
      expect(out.bindings).toEqual([scope]);
      expect(textOf(out.modules[0]!)).not.toContain(PLATFORM_SWEEPER_MODULE);
    }
  });

  it('leaves a vertical that exports its own sweeper exactly as it declared it', () => {
    const own = vertical({ declaresSchedules: true, sweeperClasses: ['SweeperDO'], doClasses: ['ScopeDO', 'SweeperDO'], bindings: [scope, ownSweeper] });
    expect(platformSweeperPlan(own)).toEqual({ keep: expect.stringContaining('its own sweeper (SweeperDO)') });
    const out = withPlatformEntry(own);
    expect(out.modules.map((m) => m.name)).toEqual([PLATFORM_ENTRY_MODULE, 'worker.js']);
    expect(out.doClasses).toEqual(own.doClasses);
    expect(out.bindings).toEqual(own.bindings);
    // Its own name, too: the decision is the declaration's, not the convention's.
    const renamed = vertical({
      declaresSchedules: true,
      sweeperClasses: ['Timer'],
      bindings: [scope, { type: 'durable_object_namespace', name: 'TIMER', class_name: 'Timer' }],
    });
    expect(platformSweeperPlan(renamed)).toEqual({ keep: expect.stringContaining('(Timer)') });
  });

  it('refuses an own sweeper no binding names — its alarm would never run', () => {
    expect(refused({ declaresSchedules: true, sweeperClasses: ['SweeperDO'], doClasses: ['ScopeDO', 'SweeperDO'] })).toMatch(
      /exports its own sweeper \(SweeperDO\), but no Durable Object binding names that class/,
    );
  });

  it('refuses to supply under names the version already binds to something else', () => {
    expect(
      refused({ declaresSchedules: true, sweeperClasses: [], bindings: [scope, { type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'Other' }] }),
    ).toMatch(/already binds the name 'SWEEPER'/);
    expect(
      refused({ declaresSchedules: true, sweeperClasses: [], bindings: [scope, { type: 'durable_object_namespace', name: 'X', class_name: 'SweeperDO' }] }),
    ).toMatch(/already binds the class 'SweeperDO'/);
  });

  it('supplies once to a vertical that dropped its own, keeping the class its migrations named', () => {
    // meridian's shape: `SweeperDO` stays in an append-only migration history after the export goes.
    const out = withPlatformEntry(vertical({ declaresSchedules: true, sweeperClasses: [], doClasses: ['ScopeDO', 'SweeperDO'] }));
    expect(out.doClasses).toEqual(['ScopeDO', 'SweeperDO']);
    expect(out.bindings.filter((b) => b.name === PLATFORM_SWEEPER_BINDING)).toHaveLength(1);
  });

  describe('a push from a CLI that predates sweeperClasses', () => {
    it('reads SWEEPER bound to SweeperDO as the vertical’s own', () => {
      const out = withPlatformEntry(vertical({ declaresSchedules: true, doClasses: ['ScopeDO', 'SweeperDO'], bindings: [scope, ownSweeper] }));
      expect(out.modules.map((m) => m.name)).toEqual([PLATFORM_ENTRY_MODULE, 'worker.js']);
      expect(out.bindings).toEqual([scope, ownSweeper]);
    });

    it('supplies one when neither name is bound', () => {
      expect(platformSweeperPlan(vertical({ declaresSchedules: true }))).toBe('supply');
    });

    it('refuses the half-matches it cannot tell apart', () => {
      expect(
        refused({ declaresSchedules: true, bindings: [scope, { type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'Timer' }] }),
      ).toMatch(/predates them.*binds the name 'SWEEPER' to another class/);
      expect(
        refused({ declaresSchedules: true, bindings: [scope, { type: 'durable_object_namespace', name: 'TIMER', class_name: 'SweeperDO' }] }),
      ).toMatch(/binds the class 'SweeperDO' under another name/);
    });

    it('never reads the bytes: a bundle full of sweeper code changes nothing', () => {
      const code = js('worker.js', 'class S { noteScope(){} forgetScope(){} sweepNow(){} ensureArmed(){} } export default {}');
      expect(platformSweeperPlan({ ...vertical({ declaresSchedules: true }), modules: [code] })).toBe('supply');
    });
  });

  it('replaces a re-served archive’s sweeper module rather than stacking a second', () => {
    const first = withPlatformEntry(vertical({ declaresSchedules: true, sweeperClasses: [] }));
    // What the archive script gives back: the modules as uploaded, the manifest as pushed.
    const again = withPlatformEntry(vertical({ declaresSchedules: true, sweeperClasses: [], modules: first.modules }));
    expect(again.modules.map((m) => m.name)).toEqual([PLATFORM_ENTRY_MODULE, PLATFORM_SWEEPER_MODULE, 'worker.js']);
    expect(textOf(again.modules[0]!)).toBe(textOf(first.modules[0]!));
  });

  describe('through the uploader', () => {
    async function upload(facts: Partial<VerticalBundle>, inPlace?: { priorDoClasses: string[]; priorMigrationTag: string }) {
      let body: FormData | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: { body?: FormData }) => {
          body = init.body;
          return new Response('{}', { status: 200 });
        }),
      );
      const full: VerticalBundle = { ...vertical(facts), compatibilityDate: '2025-01-01', compatibilityFlags: [] } as VerticalBundle;
      await createWfpUploader({ accountId: 'a', namespace: 'n', apiToken: 't' })('acme-01k', full, inPlace);
      return { meta: JSON.parse(await (body!.get('metadata') as File).text()) as Record<string, any>, body: body! };
    }

    it('declares the class in a fresh script’s migration and binds it', async () => {
      const { meta, body } = await upload({ declaresSchedules: true, sweeperClasses: [] });
      expect(meta['migrations']).toEqual({ new_tag: 'v1', new_sqlite_classes: ['ScopeDO', 'SweeperDO'] });
      expect(meta['bindings']).toContainEqual({ type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'SweeperDO' });
      expect(meta['bindings']).toContainEqual({ type: 'plain_text', name: 'SUBSTRAT_SCOPE_SWEEPER', text: 'SWEEPER' });
      expect(body.get(PLATFORM_SWEEPER_MODULE)).toBeInstanceOf(File);
    });

    it('takes over a serving script’s own SweeperDO with no migration — the namespace, roster and alarm carry over', async () => {
      // The serving script already declares `SweeperDO` (the vertical's hand-wired one, until this version).
      const { meta } = await upload({ declaresSchedules: true, sweeperClasses: [] }, { priorDoClasses: ['ScopeDO', 'SweeperDO'], priorMigrationTag: 'v2' });
      expect(meta['migrations']).toBeUndefined();
      expect(meta['bindings']).toContainEqual({ type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'SweeperDO' });
    });

    it('adds the class under the next tag to a serving script that never had one', async () => {
      const { meta } = await upload({ declaresSchedules: true, sweeperClasses: [] }, { priorDoClasses: ['ScopeDO'], priorMigrationTag: 'v1' });
      expect(meta['migrations']).toEqual({ old_tag: 'v1', new_tag: 'v2', new_sqlite_classes: ['SweeperDO'] });
    });

    it('refuses the upload, sending nothing, when the declaration contradicts itself', async () => {
      await expect(upload({ declaresSchedules: true, sweeperClasses: ['SweeperDO'] })).rejects.toMatchObject({ upstreamStatus: 422 });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });
});
