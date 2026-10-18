import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationInputsOf } from '../packages/contracts/dist/index.js';
import { adoptionOffences, targetedOperations } from './entity-check-adoption.mts';
import type { Registration } from './package-registrations.mts';

const suite = `entityCheckConformanceSuite(conformance.subject, conformance.operations, fixture);`;

test('a package with entity-addressed operations and the suite passes', () => {
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', targeted: ['x/rename'], tests: ['other', suite] }]), []);
});

test('a package with entity-addressed operations and no suite is refused, naming them', () => {
  const [offence] = adoptionOffences([{ label: 'demos/x', targeted: ['x/a', 'x/b', 'x/c', 'x/d'], tests: ['invoke("x/a")'] }]);
  assert.match(offence!, /^demos\/x: 4 operation\(s\) declare an entity check \(x\/a, x\/b, x\/c, …\) and no test calls entityCheckConformanceSuite$/);
});

test('an import of the suite that never calls it is not adoption', () => {
  const tests = [`import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';`];
  assert.equal(adoptionOffences([{ label: 'demos/x', targeted: ['x/a'], tests }]).length, 1);
});

test('a package with no entity-addressed operation needs no suite', () => {
  assert.deepEqual(adoptionOffences([{ label: 'demos/x', targeted: [], tests: [] }]), []);
});

test('the targets are read off the declarations: idFrom counts, a bare key does not', () => {
  // No input schemas: the targets are read off `permission` alone.
  const ops = {
    'x/rename': { permission: { key: 'x:manage', entity: 'thing', idFrom: 'id' } },
    'x/create': { permission: 'x:create' },
  };
  const registration = { manifest: { id: 'x' }, operations: { inputs: operationInputsOf(ops) } } as unknown as Registration;
  assert.deepEqual(targetedOperations([registration]), ['x/rename']);
});
