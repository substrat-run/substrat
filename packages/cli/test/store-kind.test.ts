import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packStoreKindDir } from '../src/store-kind.js';

describe('packStoreKindDir', () => {
  it('packs the python files and requires the entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-kind-pack-'));
    try {
      writeFileSync(join(dir, 'kind_counter.py'), 'class Store:\n    pass\n');
      writeFileSync(join(dir, 'notes.txt'), 'no');
      const body = packStoreKindDir(dir, 'kind_counter.py', 'rel-1');
      expect(body.entry).toBe('kind_counter.py');
      expect(body.modules.map((m) => m.name)).toEqual(['kind_counter.py']);
      expect(body.releaseId).toBe('rel-1');
      expect(() => packStoreKindDir(dir, 'missing.py', 'rel-1')).toThrow(/missing.py/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
