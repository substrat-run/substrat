import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Step 4a's baseline inventory. In 4b the same assertion changes to an empty inventory. The scan
 * discovers every production source mentioning StoreDriverRegistration, STORE_DRIVERS or its
 * schema, then inventories every direct releases/className property read in those files. A newly
 * typed registration reader therefore has to be added to this explicit baseline. The fields
 * disappear in 4b, giving typecheck a second guard against a pin reader.
 */
const PIN_READERS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'packages/control-plane-api/src/api.ts': { 'registration.releases': 5 },
  'packages/control-plane-api/src/deploy.ts': { 'driver.releases': 1, 'driver.className': 1 },
  'packages/control-plane-api/src/store-script.ts': { 'driver.releases': 1, 'driver.className': 1, 'script.releases': 2, 'script.className': 1 },
  'packages/control-plane-api/src/store-releases.ts': { 'registration.releases': 1 },
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [path] : [];
  });
}

function registrationSourceFiles(): string[] {
  const roots = ['packages/control-plane-api/src', 'packages/contracts/src', 'packages/cli/src', 'apps/control-plane/src'];
  return roots.flatMap((root) => sourceFiles(join(ROOT, root))).filter((path) => {
    const text = readFileSync(path, 'utf8');
    return /\b(?:StoreDriverRegistration|STORE_DRIVERS|storeDriverRegistration)\b/.test(text);
  });
}

function propertyReads(source: string): Record<string, number> {
  const reads: Record<string, number> = {};
  for (const match of source.matchAll(/\b[A-Za-z_$][\w$]*\.(?:releases|className)\b/g)) {
    reads[match[0]] = (reads[match[0]] ?? 0) + 1;
  }
  return reads;
}

describe('store driver release reader inventory (RFC §5 step 4)', () => {
  it('holds every typed pin/class read to the explicit 4a baseline', () => {
    const actual: Record<string, Record<string, number>> = {};
    for (const path of registrationSourceFiles()) {
      const reads = propertyReads(readFileSync(path, 'utf8'));
      const relevant = Object.fromEntries(Object.entries(reads).filter(([name]) => name.endsWith('.releases') || name.endsWith('.className')));
      if (Object.keys(relevant).length > 0) actual[relative(ROOT, path)] = relevant;
    }
    expect(actual).toEqual(PIN_READERS);
  });
});
