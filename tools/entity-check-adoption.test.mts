import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationInputsOf } from '../packages/contracts/dist/index.js';
import { adoptionOffences, targetedOperations } from './entity-check-adoption.mts';
import type { Registration } from './package-registrations.mts';

const suite = `entityCheckConformanceSuite(conformance.subject, conformance.operations, fixture);`;
const one = (targeted: string[]) => [{ id: 'x', targeted }];

test('a package with entity-addressed operations and the suite passes', () => {
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', modules: one(['x/rename']), tests: ['other', suite] }]), []);
});

test('a package with entity-addressed operations and no suite is refused, naming them', () => {
  const [offence] = adoptionOffences([{ label: 'demos/x', modules: one(['x/a', 'x/b', 'x/c', 'x/d']), tests: ['invoke("x/a")'] }]);
  assert.match(offence!, /^demos\/x: 4 operation\(s\) declare an entity check \(x\/a, x\/b, x\/c, …\) and no test calls entityCheckConformanceSuite$/);
});

test('an import of the suite that never calls it is not adoption', () => {
  const tests = [`import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';`];
  assert.equal(adoptionOffences([{ label: 'demos/x', modules: one(['x/a']), tests }]).length, 1);
});

test('a call in a comment is not adoption, line or block', () => {
  for (const text of [`// ${suite}`, `/* ${suite} */`, `/**\n * ${suite}\n */`]) {
    assert.equal(adoptionOffences([{ label: 'demos/x', modules: one(['x/a']), tests: [text] }]).length, 1, text);
  }
});

test('two modules that declare entity checks need a suite call each', () => {
  const modules = [{ id: 'x', targeted: ['x/a'] }, { id: 'y', targeted: ['y/b'] }, { id: 'z', targeted: [] }];
  assert.match(adoptionOffences([{ label: 'demos/x', modules, tests: [suite] }])[0]!, /2 module\(s\) declare entity checks \(x, y\) and the tests call entityCheckConformanceSuite 1 time\(s\)/);
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', modules, tests: [suite, suite] }]), []);
});

test('a package with no entity-addressed operation needs no suite', () => {
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', modules: one([]), tests: [] }]), []);
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
