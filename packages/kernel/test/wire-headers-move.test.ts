/**
 * #1978: the wire header names moved to `@substrat-run/contracts`, and since #1998 the kernel
 * no longer re-exports them — nor `invocationLevelOf`, which contracts already defined. One
 * definition of each string: two agree only until one of them is edited.
 *
 * The other moved names are held by their new homes' tests. What this file also pins is the
 * one deprecation left in the index — the platform-call check, whose move waits on a home
 * for its two remaining non-vertical callers — so a forgotten tag cannot linger unnoticed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@substrat-run/contracts';
import * as wireHeaders from '@substrat-run/contracts/wire-headers';
import * as kernel from '../src/index.js';

/** Every export the index tags as moving, as `[package, name]`. */
function tagged(): [string, string][] {
  const index = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8');
  const tag = /@deprecated Import from `([^`]+)`[^*]*\*\/\s*(?:type\s+)?(\w+)/g;
  return [...index.matchAll(tag)].map(([, to, name]) => [to!, name!]);
}

const kernelExports = kernel as Record<string, unknown>;
const contractsExports = contracts as Record<string, unknown>;
const WIRE_HEADERS = Object.keys(wireHeaders);

// @ts-expect-error moved to contracts
export type MovedLiveRefusal = kernel.LiveRefusal;
// @ts-expect-error moved to contracts
export type MovedInvocationLevel = kernel.InvocationLevel;

describe('wire header names, moved to contracts (#1978)', () => {
  it('the only names still tagged as moving are the platform-call check', () => {
    expect(tagged().sort()).toEqual([
      ['@substrat-run/vertical-host', 'PlatformCallError'],
      ['@substrat-run/vertical-host', 'assertPlatformCall'],
      ['@substrat-run/vertical-host', 'kickFlags'],
    ]);
  });

  it.each([...WIRE_HEADERS, 'invocationLevelOf'])('contracts exports %s, and the kernel does not', (name) => {
    expect(contractsExports[name], name).toBeDefined();
    expect(kernelExports[name], name).toBeUndefined();
  });

  it.each(WIRE_HEADERS)('the package root re-exports %s from the subpath', (name) => {
    expect(contractsExports[name]).toBe((wireHeaders as Record<string, unknown>)[name]);
  });

  it('no kernel source file defines one any more', () => {
    const defines = (name: string) => new RegExp(`\\bconst ${name}\\b`);
    // The pattern is not vacuous: it finds every definition in the file that now holds them.
    const home = readFileSync(join(import.meta.dirname, '../../contracts/src/wire-headers.ts'), 'utf8');
    for (const name of WIRE_HEADERS) expect(home, name).toMatch(defines(name));

    const src = join(import.meta.dirname, '../src');
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
    expect(files).toContain('platform-call.ts');
    for (const file of files) {
      const text = readFileSync(join(src, file), 'utf8');
      for (const name of WIRE_HEADERS) expect(text, `${file} defines ${name}`).not.toMatch(defines(name));
    }
  });

  it('the values are the ones on the wire', () => {
    expect({ ...wireHeaders }).toEqual({
      PLATFORM_SECRET_HEADER: 'x-substrat-platform',
      PLATFORM_REQUEST_HEADER: 'x-substrat-platform-request',
      EXPORTED_EVENTS_HEADER: 'x-substrat-exported-events',
      CONNECTOR_ATTACHMENT_RECORD_HEADER: 'x-substrat-attachment',
      LIVE_MODE_HEADER: 'x-substrat-live',
      LOAD_STAMP_HEADER: 'x-substrat-load-stamp',
      WRITE_REVISION_HEADER: 'x-substrat-write-revision',
    });
  });
});
