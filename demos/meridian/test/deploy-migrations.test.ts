/**
 * What adding the sweeper does to a LIVE script's Durable Object migrations (#1646).
 *
 * Meridian is the hand-authored-config path: its classes live in `wrangler.jsonc`, where
 * the sweeper rides a new `v2` tag beside the shipped `v1`. That tag is for a local
 * `wrangler dev` with persisted state. It is NOT what a hosted script migrates under, and
 * this suite holds that end to end, on this vertical's real config:
 *
 *   wrangler.jsonc
 *     → the CLI's own derivation (`resolveWranglerConfig`, then `declaredStoresOf`, the
 *       exact code `substrat push` runs — it flattens the tags away)
 *     → the control plane's sandbox check (`assertSandboxContract`)
 *     → the WfP uploader's metadata (`createWfpUploader`), for BOTH scripts a push reaches:
 *       a fresh per-version script, and the in-place update of the serving script that a
 *       promote performs.
 *
 * The prior serving state below is two classes under `v1` — what a serving script first
 * served with ScopeDO and IdentityDO holds if no class was added since (meridian has had
 * both since #206, before in-place serving existed). The promote reads the platform's own
 * record of the serving script rather than this file, and the upload carries its tag as
 * `old_tag`, which Cloudflare checks against the script's current tag before applying
 * anything: a record that disagreed would fail the promote whole, not half-apply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredStoresOf, resolveWranglerConfig } from '@substrat-run/cli/dist/push.js';
import { assertSandboxContract, createWfpUploader } from '@substrat-run/control-plane-api';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What `substrat push demos/meridian` declares: its bindings and its DO classes. */
function declared() {
  return declaredStoresOf(resolveWranglerConfig(dir).cfg);
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
  await createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' })(
    'meridian',
    {
      entry: 'worker.js',
      compatibilityDate: '2025-01-01',
      compatibilityFlags: ['nodejs_compat'],
      modules: [{ name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' }],
      doClasses,
      bindings,
    },
    inPlace,
  );
  return JSON.parse(await (body!.get('metadata') as File).text()) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe('meridian deploy config — the sweeper as a store (#1646)', () => {
  it('the push declares the sweeper as the vertical\'s own third class, bound as SWEEPER', () => {
    const { bindings, doClasses } = declared();
    expect(doClasses).toEqual(['ScopeDO', 'IdentityDO', 'SweeperDO']);
    expect(bindings).toContainEqual({ type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'SweeperDO' });
    // The control plane's §4 check admits it: an OWN class, bound by its own script.
    expect(() => assertSandboxContract({ bindings, doClasses } as Parameters<typeof assertSandboxContract>[0])).not.toThrow();
  });

  it('a fresh script declares all three under v1 — the wrangler.jsonc `v2` tag does not travel', async () => {
    const meta = await uploadMetadata();
    expect(meta['migrations']).toEqual({ new_tag: 'v1', new_sqlite_classes: ['ScopeDO', 'IdentityDO', 'SweeperDO'] });
  });

  it('the in-place serving script gains ONLY the sweeper, under its next tag — the live classes are not re-declared', async () => {
    const meta = await uploadMetadata({ priorDoClasses: ['ScopeDO', 'IdentityDO'], priorMigrationTag: 'v1' });
    expect(meta['migrations']).toEqual({ old_tag: 'v1', new_tag: 'v2', new_sqlite_classes: ['SweeperDO'] });
    expect(meta['keep_bindings']).toEqual(['secret_text', 'secret_key']);
  });

  it('the promote after that one sends no migration at all', async () => {
    const meta = await uploadMetadata({ priorDoClasses: ['ScopeDO', 'IdentityDO', 'SweeperDO'], priorMigrationTag: 'v2' });
    expect(meta['migrations']).toBeUndefined();
  });
});
