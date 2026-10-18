import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACCEPTED, SHAPES, findLiterals, scan } from './secret-literals.mjs';

// Every fake value is assembled at run time, so this file holds no literal the gate would find.
const pemBody = 'MIIEv' + 'Q'.repeat(59);
const fakes = {
  'PEM private key': `-----BEGIN ${'PRIVATE'} KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`,
  'PEM private key (escaped)': `"-----BEGIN RSA ${'PRIVATE'} KEY-----\\n${pemBody}\\n"`,
  'JWK private exponent': `{ kty: 'EC', ${'d'}: '${'a1B2'.repeat(11)}' }`,
  'AWS access key id': `${'AK'}IA${'ABCDEFGHIJKLMNOP'}`,
  'GitHub token': `${'gh'}p_${'a'.repeat(36)}`,
  'Anthropic API key': `${'sk-'}ant-${'api03-'}${'x'.repeat(30)}`,
  'OpenAI API key': `${'sk-'}proj-${'Z'.repeat(48)}`,
  'Slack token': `${'xo'}xb-${'1234567890'}-abc`,
  'Stripe live key': `${'sk_'}live_${'9'.repeat(24)}`,
  'Google API key': `${'AI'}za${'b'.repeat(35)}`,
  'npm token': `${'npm'}_${'c'.repeat(36)}`,
  'connection URL with a password': `${'postgres'}://app:${'s3cret-pw'}@db.internal:5432/x`,
};
const file = (path, text) => ({ path, text });

test('every shape finds its fake, and reports the shape name, never the value', () => {
  for (const [label, value] of Object.entries(fakes)) {
    const hits = scan(`\nconst x = ${value};\n`);
    const shape = label.replace(' (escaped)', '');
    assert.deepEqual(hits.map((h) => h.shape), [shape], label);
    assert.deepEqual(Object.keys(hits[0]).sort(), ['digest', 'line', 'shape'], label);
    const offence = findLiterals([file('a/x.ts', value)], {})[0];
    assert.ok(!offence.includes(value) && !offence.includes(value.slice(12, 30)), `${label}: the value must not be printed`);
  }
  assert.equal(new Set(SHAPES.map((s) => s.name)).size, SHAPES.length);
});

test('the line is reported', () => {
  assert.deepEqual(findLiterals([file('a/x.ts', `one\ntwo\n${fakes['GitHub token']}\n`)], {}), ['a/x.ts:3: GitHub token']);
});

test('the shapes that are not keys pass: armour without a body, a placeholder, a template, an empty password', () => {
  const clean = [
    "placeholder={'-----BEGIN PRIVATE KEY-----\\n…'}",
    '# KEY="-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n"',
    'return `-----BEGIN PRIVATE KEY-----\\n${base64}\\n-----END PRIVATE KEY-----`;',
    "const PEM_KEY = '-----BEGIN PRIVATE KEY-----\\nMIIE-test\\n-----END PRIVATE KEY-----';",
    'DATABASE_URL=postgres://app@localhost:5432/x',
    'url = `postgres://${user}:${password}@${host}`',
    "const id = 'sk-short';",
    "{ d: 'short' }",
  ];
  assert.deepEqual(findLiterals(clean.map((text, i) => file(`a/${i}.ts`, text)), {}), []);
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const jwk = fakes['JWK private exponent'];
const jwkMatch = jwk.slice(jwk.indexOf('d:'), -2); // the text the shape matches: d: '…'
const accepted = { 'a/dev-key.ts': { shape: 'JWK private exponent', digests: [sha256(jwkMatch)], reason: 'a dev-only key' } };

test('the digest pinned is of the matched text, and an accepted file passes with that value', () => {
  assert.deepEqual(scan(jwk).map((h) => h.digest), [sha256(jwkMatch)]);
  assert.deepEqual(findLiterals([file('a/dev-key.ts', jwk)], accepted), []);
});

test('a DIFFERENT value of the accepted shape in the accepted file is refused: the entry pins values, not a count', () => {
  const swapped = jwk.replace('a1B2', 'z9Y8');
  const [offence, ...rest] = findLiterals([file('a/dev-key.ts', swapped)], accepted);
  assert.match(offence, /^a\/dev-key\.ts:1: JWK private exponent — not an accepted value \(sha256 [0-9a-f]{64}\)/);
  assert.ok(!offence.includes('z9Y8'), 'the value must not be printed');
  assert.match(rest[0], /sha256 [0-9a-f]{64} is no longer in the file/);
});

test('the same shape in a NEW file is refused although another file is accepted for it', () => {
  const offences = findLiterals([file('a/dev-key.ts', jwk), file('a/new.ts', jwk)], accepted);
  assert.deepEqual(offences, ['a/new.ts:1: JWK private exponent']);
});

test('a second, different value beside the accepted one is refused; the accepted one going away is stale', () => {
  const two = `${jwk}\n${jwk.replace('a1B2', 'q7W6')}`;
  assert.equal(findLiterals([file('a/dev-key.ts', two)], accepted).length, 1);
  assert.match(findLiterals([file('a/dev-key.ts', 'nothing')], accepted)[0], /is no longer in the file/);
});

test('another shape in an accepted file is refused: the entry covers its own shape only', () => {
  const text = `${jwk}\n${fakes['Stripe live key']}`;
  assert.deepEqual(findLiterals([file('a/dev-key.ts', text)], accepted), ['a/dev-key.ts:2: Stripe live key']);
});

test('an entry for a file that is not read is refused as stale', () => {
  assert.match(findLiterals([], accepted)[0], /accepted in tools\/secret-literals\.mjs but not read/);
});

test('every accepted entry carries a reason', () => {
  for (const [path, entry] of Object.entries(ACCEPTED)) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 20, `${path} needs a reason`);
    assert.ok(SHAPES.some((s) => s.name === entry.shape), `${path} names an unknown shape`);
    assert.ok(entry.digests.length > 0 && entry.digests.every((d) => /^[0-9a-f]{64}$/.test(d)), `${path} pins sha256 digests`);
  }
});
