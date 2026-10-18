import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationInputsOf } from '../packages/contracts/dist/index.js';
import { adoptionOffences, targetedOperations } from './entity-check-adoption.mts';
import type { Registration } from './package-registrations.mts';

const suite = `entityCheckConformanceSuite(conformance.subject, conformance.operations, fixture);`;
const one = (targeted: string[]) => [{ id: 'x', targeted }];
const all = new Set(['x/rename', 'x/a', 'x/b', 'x/c', 'x/d', 'y/b']);

test('a package with entity-addressed operations and the suite passes', () => {
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', modules: one(['x/rename']), tests: ['other', suite], covered: all }]), []);
});

test('a package with entity-addressed operations and no suite is refused, naming them', () => {
  const [offence] = adoptionOffences([{ label: 'demos/x', modules: one(['x/a', 'x/b', 'x/c', 'x/d']), tests: ['invoke("x/a")'], covered: all }]);
  assert.match(offence!, /^demos\/x: 4 operation\(s\) declare an entity check \(x\/a, x\/b, x\/c, …\) and no test calls entityCheckConformanceSuite$/);
});

test('an import of the suite that never calls it is not adoption', () => {
  const tests = [`import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';`];
  assert.equal(adoptionOffences([{ label: 'demos/x', modules: one(['x/a']), tests, covered: all }]).length, 1);
});

test('a call in a comment is not adoption, line or block', () => {
  for (const text of [`// ${suite}`, `/* ${suite} */`, `/**\n * ${suite}\n */`]) {
    assert.equal(adoptionOffences([{ label: 'demos/x', modules: one(['x/a']), tests: [text], covered: all }]).length, 1, text);
  }
});

test('each module\'s entity-checked operations must be in what the suite is given, however many calls there are', () => {
  const modules = [{ id: 'x', targeted: ['x/a'] }, { id: 'y', targeted: ['y/b'] }, { id: 'z', targeted: [] }];
  const onlyX = new Set(['x/a']);
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', modules, tests: [suite, suite], covered: onlyX }]), [
    'demos/x: module y declares entity checks the conformance suite is not given (y/b)',
  ]);
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', modules, tests: [suite], covered: new Set(['x/a', 'y/b']) }]), []);
});

test('a suite call with no conformance declaration to read is refused, not trusted', () => {
  assert.match(adoptionOffences([{ label: 'demos/x', modules: one(['x/a']), tests: [suite], covered: undefined }])[0]!, /names no conformance declaration/);
});

test('a package with no entity-addressed operation needs no suite', () => {
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', modules: one([]), tests: [], covered: all }]), []);
});

test('the targets are read off the declarations: idFrom counts, a bare key does not', () => {
  // No input schemas: the targets are read off `permission` alone.
  const ops = {
    'x/rename': { permission: { key: 'x:manage', entity: 'thing', idFrom: 'id' } },
    'x/create': { permission: 'x:create' },
  };
  const registration = { manifest: { id: 'x' }, operations: { inputs: operationInputsOf(ops) } } as unknown as Registration;
  assert.deepEqual(targetedOperations(registration), ['x/rename']);
});
