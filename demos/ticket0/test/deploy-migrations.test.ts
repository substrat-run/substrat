/**
 * What adding the sweeper does to a LIVE script's Durable Object migrations (#1646) — and,
 * since #1902, what the platform SUPPLYING it does: ticket0 no longer exports or binds a
 * sweeper of its own, the push route decides to supply one, and the uploader adds it under
 * the class name ticket0's own used, so a serving script's namespace carries over.
 *
 * `SweeperDO` is a new class on a script that already serves desks, and a wrong migration
 * block is the one way this change can hurt what is already running: re-declaring a live
 * class is an upload error, and a class declared under the wrong tag is refused. So the
 * claim "the vertical only appends a class; the platform picks the tag" is held here,
 * end to end, on THIS vertical's real config:
 *
 *   package.json `substrat.runtimeNeeds`
 *     → the CLI's own derivation (`resolveWranglerConfig`, then `declaredStoresOf`, the
 *       exact code `substrat push` runs)
 *     → the control plane's sandbox check (`assertSandboxContract`)
 *     → the WfP uploader's metadata (`createWfpUploader`), for BOTH scripts a push reaches:
 *       the fresh per-version script, and the in-place update of the serving script that
 *       a promote performs.
 *
 * The prior serving state below is two classes under `v1` — what a serving script first
 * served with ScopeDO and IdentityDO holds if no class was added since (ticket0 has had
 * both since its first deployable worker, #922). The promote does not trust this file for
 * it: it reads the platform's own record of the serving script (`verticalServing`), and
 * the upload carries that tag as `old_tag`, which Cloudflare checks against the script's
 * current tag before applying anything. A record that disagreed with the script would
 * fail the promote whole and leave the old code serving; it could not half-apply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredStoresOf, resolveWranglerConfig } from '@substrat-run/cli/dist/push.js';
import { declaredSweeper } from '../../../tools/workerd-as-uploaded.mjs';
import { assertSandboxContract, createWfpUploader, platformSweeperDecision } from '@substrat-run/control-plane-api';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What `substrat push demos/ticket0` declares: its bindings and its DO classes. */
function declared() {
  return declaredStoresOf(resolveWranglerConfig(dir).cfg);
}

const entry = { entry: 'worker.js', modules: [{ name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' }] };

/** What the push route decides for ticket0, from what its push declares (#1902). */
async function decision() {
  const cfg = resolveWranglerConfig(dir).cfg;
  const { schedules, sweeperClasses } = await declaredSweeper(dir, cfg);
  return platformSweeperDecision(
    { schedules, bindings: declared().bindings, ...(sweeperClasses ? { sweeperClasses } : {}) },
    entry,
  );
}

/** The metadata the uploader would PUT, with Cloudflare stubbed out. */
async function uploadMetadata(inPlace?: { priorDoClasses: string[]; priorMigrationTag: string }) {
  let body: FormData | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: { body?: FormData }) => {
      body = init.body;
      return new Response('{}', { status: 200 });
    }),
  );
  const { bindings, doClasses } = declared();
  const decided = await decision();
  if ('refuse' in decided) throw new Error(decided.refuse);
  await createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' })(
    'ticket0',
    {
      entry: 'worker.js',
      compatibilityDate: '2026-06-01',
      compatibilityFlags: ['nodejs_compat'],
      modules: entry.modules,
      doClasses,
      bindings,
      supplySweeper: decided.supply,
    },
    inPlace,
  );
  return JSON.parse(await (body!.get('metadata') as File).text()) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe('ticket0 deploy config — the sweeper, supplied by the platform (#1646, #1902)', () => {
  it('the push binds no sweeper of its own and is given one, as SweeperDO bound to SWEEPER (#1902)', async () => {
    const { bindings, doClasses } = declared();
    expect(doClasses).toEqual(['ScopeDO', 'IdentityDO']);
    expect(bindings.map((b) => b.name)).toEqual(['SCOPE', 'AUTH']);
    expect(() => assertSandboxContract({ bindings, doClasses } as Parameters<typeof assertSandboxContract>[0])).not.toThrow();
    expect(await decision()).toEqual({ supply: true });
    const meta = await uploadMetadata();
    expect(meta['bindings']).toContainEqual({ type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'SweeperDO' });
  });

  it('a fresh script (every push\'s per-version script, a PR preview) declares all three under v1', async () => {
    const meta = await uploadMetadata();
    expect(meta['migrations']).toEqual({ new_tag: 'v1', new_sqlite_classes: ['ScopeDO', 'IdentityDO', 'SweeperDO'] });
  });

  it('the in-place serving script gains ONLY the sweeper, under v2 — the live classes are not re-declared', async () => {
    const meta = await uploadMetadata({ priorDoClasses: ['ScopeDO', 'IdentityDO'], priorMigrationTag: 'v1' });
    expect(meta['migrations']).toEqual({ old_tag: 'v1', new_tag: 'v2', new_sqlite_classes: ['SweeperDO'] });
    // Hand-put secrets survive the re-upload, as on every in-place serve.
    expect(meta['keep_bindings']).toEqual(['secret_text', 'secret_key']);
  });

  it('the promote after that one — or onto a script whose hand-wired SweeperDO it replaces — sends no migration at all', async () => {
    const meta = await uploadMetadata({ priorDoClasses: ['ScopeDO', 'IdentityDO', 'SweeperDO'], priorMigrationTag: 'v2' });
    expect(meta['migrations']).toBeUndefined();
  });
});
