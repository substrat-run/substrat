import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTruncatedVersions } from './version-label.mjs';

const flagged = (src) => findTruncatedVersions(src).map((f) => f.line);

// The samples are assembled so that no line of THIS file reads as the thing it describes:
// `lint:tests` runs the detector over every tracked script file, this one included.
const cut = (n) => `.slice(-${n})`;

test('flags a version label built from a slice of an id, in every spelling the repo had', () => {
  assert.deepEqual(flagged(`publish({ id, version: \`1.0.\${id${cut(4)}.toLowerCase()}\`, x: 1 })`), [1]);
  assert.deepEqual(flagged(`  version: \`3.0.\${versionId${cut(6)}}\`,`), [1]);
  assert.deepEqual(flagged(`  version: id${cut(6)},`), [1]);
  assert.deepEqual(flagged(`x\n  version: v4${'.slice( -6 )'},\ny`), [2]);
  assert.deepEqual(flagged(`  version: \`0.1.\${row.id${cut(4)}.toLowerCase()}\``), [1]);
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
