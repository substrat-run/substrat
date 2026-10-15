import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { storeKindReleaseUpload } from '@substrat-run/contracts';
import { packStoreKindDir } from '../src/store-kind.js';

const COMMIT = 'a'.repeat(40);

function kindDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-kind-pack-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('packStoreKindDir (#2300)', () => {
  it('packs the kind package recursively by relative path, skipping bytecode', () => {
    const dir = kindDir({
      'kind_graph/__init__.py': '',
      'kind_graph/store.py': 'class Store:\n    pass\n',
      'kind_graph/schema/v1.py': 'X = 1\n',
      'kind_graph/__pycache__/store.cpython-312.pyc': 'bytecode',
    });
    try {
      const body = packStoreKindDir(dir, 'kind_graph/store.py', COMMIT);
      expect(body.modules.map((m) => m.name)).toEqual(['kind_graph/__init__.py', 'kind_graph/schema/v1.py', 'kind_graph/store.py']);
      expect(atob(body.modules[2]!.contentBase64)).toBe('class Store:\n    pass\n');
      // What the control plane parses.
      expect(storeKindReleaseUpload.safeParse(body).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a vendored package or any other file by name, a second package, and a missing entry', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ 'kind_graph/store.py': '', 'python_modules/six.py': '' }, /refused: python_modules\/six\.py.*Vendored/],
      [{ 'kind_graph/store.py': '', 'kind_graph/data.json': '{}' }, /refused: kind_graph\/data\.json/],
      [{ 'kind_graph/store.py': '', 'wrangler.toml': '' }, /refused: wrangler\.toml/],
      [{ 'kind_graph/store.py': '', 'kind_other/x.py': '' }, /exactly one kind_ package/],
    ];
    for (const [files, refusal] of cases) {
      const dir = kindDir(files);
      try {
        expect(() => packStoreKindDir(dir, 'kind_graph/store.py', COMMIT), JSON.stringify(files)).toThrow(refusal);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const dir = kindDir({ 'kind_graph/store.py': '' });
    try {
      expect(() => packStoreKindDir(dir, 'kind_graph/missing.py', COMMIT)).toThrow(/missing\.py/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
