import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncConceptFile } from '../src/concept.js';

/**
 * `substrat concept sync` — the filesystem half over `@substrat-run/model-view`'s `syncConcept`
 * (#2362). The rendering is held by that package's suite; this holds what is the CLI's own:
 * where the three files live, that a second run writes nothing, and that `--check` writes
 * nothing even when the file is stale.
 */

const MODEL = {
  entities: {
    list: { table: 't_lists', fields: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
  },
};
const PERMISSIONS = '## 1. Registry\n\n| Key | Description | Declared by |\n| --- | --- | --- |\n| `list:create` | Create | `x` |\n\n## 2. Roles\n\n| Role | Permissions |\n| --- | --- |\n| `member` | `list:create` |\n';
const DOC = `# C

<!-- substrat:roles -->
<!-- /substrat:roles -->
<!-- substrat:entities -->
<!-- /substrat:entities -->
<!-- substrat:processes -->
<!-- /substrat:processes -->

## Decisions log
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concept-'));
  mkdirSync(join(dir, 'spec'));
  writeFileSync(join(dir, 'model.json'), JSON.stringify(MODEL));
  writeFileSync(join(dir, 'PERMISSIONS.md'), PERMISSIONS);
  writeFileSync(join(dir, 'spec/concept.md'), DOC);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('syncConceptFile', () => {
  it('writes the generated regions, then finds nothing to do on a second run', () => {
    const first = syncConceptFile(dir);
    expect(first.changed).toBe(true);
    const text = readFileSync(first.file, 'utf8');
    expect(text).toContain('| `member` | `list:create` — Create |');
    expect(text).toContain('erDiagram');
    expect(syncConceptFile(dir).changed).toBe(false);
    expect(readFileSync(first.file, 'utf8')).toBe(text);
  });

  it('--check reports a stale file and leaves it as it was', () => {
    expect(syncConceptFile(dir, { check: true }).changed).toBe(true);
    expect(readFileSync(join(dir, 'spec/concept.md'), 'utf8')).toBe(DOC);
  });

  it('accepts the model.json path as well as its directory', () => {
    expect(syncConceptFile(join(dir, 'model.json')).changed).toBe(true);
  });

  it('refuses a missing concept.md, naming the markers', () => {
    rmSync(join(dir, 'spec/concept.md'));
    expect(() => syncConceptFile(dir)).toThrow(/no spec\/concept\.md.*substrat:roles/s);
  });

  it('refuses a document without the markers rather than writing nothing', () => {
    writeFileSync(join(dir, 'spec/concept.md'), '# C\n');
    expect(() => syncConceptFile(dir)).toThrow(/substrat:roles/);
  });
});
