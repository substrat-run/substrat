import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTruncatedVersions } from './version-label.mjs';

const flagged = (src) => findTruncatedVersions(src).map((f) => f.line);

// The samples are assembled so that no line of THIS file reads as the thing it describes:
// `lint:tests` runs the detector over every tracked script file, this one included.
const cut = (n) => `.slice(-${n})`;
const call = (method, args) => `.${method}(${args})`;

test('flags a version label built from a slice of an id, in every spelling the repo had', () => {
  assert.deepEqual(flagged(`publish({ id, version: \`1.0.\${id${cut(4)}.toLowerCase()}\`, x: 1 })`), [1]);
  assert.deepEqual(flagged(`  version: \`3.0.\${versionId${cut(6)}}\`,`), [1]);
  assert.deepEqual(flagged(`  version: id${cut(6)},`), [1]);
  assert.deepEqual(flagged(`x\n  version: v4${call('slice', ' -6 ')},\ny`), [2]);
  assert.deepEqual(flagged(`  version: \`0.1.\${row.id${cut(4)}.toLowerCase()}\``), [1]);
});

test('flags a cut written through a call, an index, a quoted or computed key, or on the next line (review of #2411)', () => {
  assert.deepEqual(flagged(`  version: \`0.1.\${id.toLowerCase()${cut(4)}}\``), [1]);
  assert.deepEqual(flagged(`  version: ulid()${cut(4)},`), [1]);
  assert.deepEqual(flagged(`  version: mint()${cut(6)}.toLowerCase(),`), [1]);
  assert.deepEqual(flagged(`  version: ids[0]${cut(4)},`), [1]);
  assert.deepEqual(flagged(`  'version': id${cut(4)},`), [1]);
  assert.deepEqual(flagged(`  "version": id${cut(4)},`), [1]);
  assert.deepEqual(flagged(`  ['version']: id${cut(4)},`), [1]);
  assert.deepEqual(flagged(`  version:\n    \`1.0.\${id${cut(4)}}\`,`), [1]);
  assert.deepEqual(flagged(`  version:\n    id${cut(6)},`), [1]);
});

test('flags the other ways to cut a piece out of an id', () => {
  assert.deepEqual(flagged(`  version: id${call('slice', 20)},`), [1]);
  assert.deepEqual(flagged(`  version: id${call('substring', 20)},`), [1]);
  assert.deepEqual(flagged(`  version: id${call('substr', -4)},`), [1]);
  assert.deepEqual(flagged(`  version: id${call('slice', '0, 4')},`), [1]);
  assert.deepEqual(flagged(`  version: \`1.0.\${id${call('substring', '10, 14')}}\`,`), [1]);
});

test('leaves a slug, a tag, a ref, a hostname or a comment alone, even beside a version', () => {
  assert.deepEqual(flagged(`  tag: id${cut(4)},`), []);
  assert.deepEqual(flagged(`  ref: \`r-\${id${cut(6)}}\`,`), []);
  assert.deepEqual(flagged(`  hostname: \`\${id${cut(6)}}.example.test\`,`), []);
  assert.deepEqual(flagged(`// slug: id${cut(4)}, version: 1`), []);
  assert.deepEqual(flagged(`  version: '1.0.0', slug: id${cut(4)},`), []);
  assert.deepEqual(flagged(`  version: \`1.0.\${id.toLowerCase()}\`,\n  slug: id${cut(4)},`), []);
  assert.deepEqual(flagged(`  version: \`1.0.\${v.slice(1)}\`, // strips the leading v`), []);
  assert.deepEqual(flagged(`  version: 'x',\n  name: id${cut(4)},`), []);
});

test('is not misled by a template that merely spells a version property', () => {
  const swap = '`"version": "${a}"`, `"version": "${b}"`';
  assert.deepEqual(flagged(`write(text.replace(${swap}));\nconst t = \`x\`;\nconst u = id${cut(4)};`), []);
  assert.deepEqual(flagged(`msg(\`version: \${v}\`);\nconst other = \`\${id${cut(6)}}\`;`), []);
});

test('accepts the whole id, a counter and a fixed label', () => {
  assert.deepEqual(flagged('version: `1.0.${id.toLowerCase()}`'), []);
  assert.deepEqual(flagged('version: id.toLowerCase(),'), []);
  assert.deepEqual(flagged('version: `1.0.${index}`'), []);
  assert.deepEqual(flagged("version: '1.0.0',"), []);
  assert.deepEqual(flagged('version: `1.0.${v.slice(1)}`'), []);
});

test('leaves a slug, a tag or a ref that takes the tail of an id alone', () => {
  assert.deepEqual(flagged('const slug = `acme/review-${ulid().slice(-8).toLowerCase()}`;'), []);
  assert.deepEqual(flagged('slug: `strong-${strong.slice(-6).toLowerCase()}`'), []);
  assert.deepEqual(flagged('verticalSlug: `pin-${id.slice(-4)}`, name: `v-${id.slice(-4)}`'), []);
  assert.deepEqual(flagged('name: `App ${scopeId.slice(-1).toUpperCase()}`'), []);
});

test('is not fooled by a different property that ends in version', () => {
  assert.deepEqual(flagged('schemaVersion: id.slice(-4)'), []);
});
