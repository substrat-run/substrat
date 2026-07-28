import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeNeeds, RUNTIME_BASELINE } from '@substrat-run/contracts';
import { wranglerConfigFor, readRuntimeNeeds } from '../src/push.js';

const scratch = (pkg?: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cli-test-'));
  if (pkg !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
};

describe('wranglerConfigFor — the Substrat→Cloudflare mapping (D-38)', () => {
  it('maps a full runtimeNeeds to the wrangler shape push extraction reads', () => {
    const cfg = wranglerConfigFor(
      runtimeNeeds.parse({
        entry: 'src/worker.ts',
        needsNodeCompat: true,
        build: 'pnpm --dir app build',
        stores: [
          { binding: 'SCOPE', class: 'ScopeDO' },
          { binding: 'AUTH', class: 'IdentityDO' },
        ],
      }),
    );
    expect(cfg).toEqual({
      name: 'substrat-vertical',
      main: 'src/worker.ts',
      compatibility_date: RUNTIME_BASELINE,
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      build: { command: 'pnpm --dir app build' },
      durable_objects: {
        bindings: [
          { name: 'SCOPE', class_name: 'ScopeDO' },
          { name: 'AUTH', class_name: 'IdentityDO' },
        ],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['ScopeDO', 'IdentityDO'] }],
    });
  });

  it('a minimal vertical gets the platform baseline and nothing it did not ask for', () => {
    const cfg = wranglerConfigFor(runtimeNeeds.parse({ entry: 'src/worker.ts' }));
    expect(cfg).toEqual({
      name: 'substrat-vertical',
      main: 'src/worker.ts',
      compatibility_date: RUNTIME_BASELINE,
      compatibility_flags: [],
      workers_dev: false,
    });
  });

  it('the builder never picks the compatibility date — it is always the baseline', () => {
    const cfg = wranglerConfigFor(runtimeNeeds.parse({ entry: 'a.ts' }));
    expect(cfg.compatibility_date).toBe(RUNTIME_BASELINE);
  });
});

describe('readRuntimeNeeds', () => {
  it('parses package.json substrat.runtimeNeeds with defaults applied', () => {
    const dir = scratch({ substrat: { runtimeNeeds: { entry: 'src/worker.ts' } } });
    expect(readRuntimeNeeds(dir)).toEqual({
      entry: 'src/worker.ts',
      needsNodeCompat: false,
      stores: [],
    });
  });

  it('is undefined when the block (or package.json) is absent — the wrangler.jsonc path', () => {
    expect(readRuntimeNeeds(scratch({ substrat: { slug: 'x' } }))).toBeUndefined();
    expect(readRuntimeNeeds(scratch())).toBeUndefined();
  });

  it('rejects an invalid declaration instead of pushing something else', () => {
    const dir = scratch({
      substrat: { runtimeNeeds: { entry: 'a.ts', stores: [{ binding: 'lower', class: 'X' }] } },
    });
    expect(() => readRuntimeNeeds(dir)).toThrow();
  });
});
