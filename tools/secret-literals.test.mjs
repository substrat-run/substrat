import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.deepEqual(Object.keys(hits[0]).sort(), ['line', 'shape'], label);
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

const accepted = { 'a/dev-key.ts': { shape: 'JWK private exponent', count: 1, reason: 'a dev-only key' } };

test('an accepted file passes at its count', () => {
  assert.deepEqual(findLiterals([file('a/dev-key.ts', fakes['JWK private exponent'])], accepted), []);
});

test('the same shape in a NEW file is refused although another file is accepted for it', () => {
  const offences = findLiterals([file('a/dev-key.ts', fakes['JWK private exponent']), file('a/new.ts', fakes['JWK private exponent'])], accepted);
  assert.deepEqual(offences, ['a/new.ts:1: JWK private exponent']);
});

test('a second match added to an accepted file is refused, and so is the count going down', () => {
  const two = `${fakes['JWK private exponent']}\n${fakes['JWK private exponent']}`;
  assert.match(findLiterals([file('a/dev-key.ts', two)], accepted)[0], /accepted for 1 JWK private exponent match\(es\), holds 2/);
  assert.match(findLiterals([file('a/dev-key.ts', 'nothing')], accepted)[0], /holds 0/);
});

test('another shape in an accepted file is refused: the entry covers its own shape only', () => {
  const text = `${fakes['JWK private exponent']}\n${fakes['Stripe live key']}`;
  assert.deepEqual(findLiterals([file('a/dev-key.ts', text)], accepted), ['a/dev-key.ts:2: Stripe live key']);
});

test('an entry for a file that is not read is refused as stale', () => {
  assert.match(findLiterals([], accepted)[0], /accepted in tools\/secret-literals\.mjs but not read/);
});

test('every accepted entry carries a reason', () => {
  for (const [path, entry] of Object.entries(ACCEPTED)) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 20, `${path} needs a reason`);
    assert.ok(SHAPES.some((s) => s.name === entry.shape), `${path} names an unknown shape`);
  }
});
