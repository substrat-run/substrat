/**
 * #1978: the wire header names moved to `@substrat-run/contracts`. The kernel re-exports them
 * for one release, and that has to be the contracts binding rather than a second definition
 * of the same string: two definitions agree only until one of them is edited.
 *
 * Which names moved is read from this package's own index, from the
 * `@deprecated Import from \`<package>\`` tag each one carries. Each new home's test reads
 * the same tags, except `@substrat-run/adapter-cloudflare`'s, which runs in workerd and
 * cannot read a source file — so its names are pinned here, against the list that test
 * asserts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@substrat-run/contracts';
import * as wireHeaders from '@substrat-run/contracts/wire-headers';
import * as kernel from '../src/index.js';

/** Every export this index tags as moving, as `[package, name]`. */
function tagged(): [string, string][] {
  const index = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8');
  const tag = /@deprecated Import from `([^`]+)`[^*]*\*\/\s*(?:type\s+)?(\w+)/g;
  return [...index.matchAll(tag)].map(([, to, name]) => [to!, name!]);
}

const kernelExports = kernel as Record<string, unknown>;
const contractsExports = contracts as Record<string, unknown>;
const TO_CONTRACTS = tagged()
  .filter(([to]) => to === '@substrat-run/contracts')
  .map(([, name]) => name)
  // A type has no runtime binding to compare.
  .filter((name) => kernelExports[name] !== undefined);
const WIRE_HEADERS = Object.keys(wireHeaders);

describe('wire header names, moved to contracts (#1978)', () => {
  it('the tags name only the four new homes, and adapter-cloudflare the four names its test asserts', () => {
    expect([...new Set(tagged().map(([to]) => to))].sort()).toEqual([
      '@substrat-run/adapter-cloudflare',
      '@substrat-run/contracts',
      '@substrat-run/control-plane-api',
      '@substrat-run/vertical-host',
    ]);
    expect(
      tagged()
        .filter(([to]) => to === '@substrat-run/adapter-cloudflare')
        .map(([, name]) => name)
        .sort(),
    ).toEqual([
      'AnalyticsEngineDatasetLike',
      'CONNECTOR_CALL_DATA_POINT_LAYOUT',
      'analyticsEngineConnectorCallRecorder',
      'connectorCallDataPoint',
    ]);
  });

  it('every wire header is tagged as moving to contracts', () => {
    for (const name of WIRE_HEADERS) expect(TO_CONTRACTS, name).toContain(name);
  });

  it.each(TO_CONTRACTS)("the kernel's %s is the contracts binding", (name) => {
    expect(contractsExports[name]).toBeDefined();
    expect(kernelExports[name]).toBe(contractsExports[name]);
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
    });
  });
});
