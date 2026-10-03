/**
 * #1978: the wire header names moved to `@substrat-run/contracts`. The kernel re-exports them
 * for one release, and that has to be the contracts binding rather than a second definition
 * of the same string: two definitions agree only until one of them is edited.
 */
import { describe, expect, it } from 'vitest';
import * as contracts from '@substrat-run/contracts';
import * as wireHeaders from '@substrat-run/contracts/wire-headers';
import * as invocationRecord from '@substrat-run/contracts/invocation-record';
import * as kernel from '../src/index.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MOVED = [
  'PLATFORM_SECRET_HEADER',
  'PLATFORM_REQUEST_HEADER',
  'EXPORTED_EVENTS_HEADER',
  'CONNECTOR_ATTACHMENT_RECORD_HEADER',
  'LIVE_MODE_HEADER',
] as const;

describe('wire header names, moved to contracts (#1978)', () => {
  it('the subpath holds exactly the moved names, and the package root re-exports each', () => {
    expect(Object.keys(wireHeaders).sort()).toEqual([...MOVED].sort());
    for (const name of MOVED) expect(contracts[name], name).toBe(wireHeaders[name]);
  });

  it('the kernel re-exports each one from contracts', () => {
    for (const name of MOVED) expect(kernel[name], name).toBe(wireHeaders[name]);
  });

  it('no kernel source file defines one any more', () => {
    const defines = (name: string) => new RegExp(`\\bconst ${name}\\b`);
    // The pattern is not vacuous: it finds every definition in the file that now holds them.
    const home = readFileSync(join(import.meta.dirname, '../../contracts/src/wire-headers.ts'), 'utf8');
    for (const name of MOVED) expect(home, name).toMatch(defines(name));

    const src = join(import.meta.dirname, '../src');
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
    expect(files).toContain('platform-call.ts');
    for (const file of files) {
      const text = readFileSync(join(src, file), 'utf8');
      for (const name of MOVED) expect(text, `${file} defines ${name}`).not.toMatch(defines(name));
    }
  });

  it('the values are the ones on the wire', () => {
    expect(wireHeaders).toEqual({
      PLATFORM_SECRET_HEADER: 'x-substrat-platform',
      PLATFORM_REQUEST_HEADER: 'x-substrat-platform-request',
      EXPORTED_EVENTS_HEADER: 'x-substrat-exported-events',
      CONNECTOR_ATTACHMENT_RECORD_HEADER: 'x-substrat-attachment',
      LIVE_MODE_HEADER: 'x-substrat-live',
    });
  });

  it("invocationLevelOf is contracts' binding too", () => {
    expect(kernel.invocationLevelOf).toBe(invocationRecord.invocationLevelOf);
  });
});
