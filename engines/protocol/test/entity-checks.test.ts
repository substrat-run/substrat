/**
 * Every entity check this engine DECLARES, driven against the handler serving it.
 *
 * Eight of the fourteen operations declare `permission: { key, entity:
 * 'protocol', idFrom: 'instanceId' }`. Nothing in the type system makes a
 * handler honour that — `ctx.check(PERM.sign)` without the ref typechecks and
 * lets anyone holding `protocol:sign` anywhere in the scope sign anyone's
 * document. On the engine behind real signature flows that is the check worth
 * having a machine verify.
 *
 * The probe holds **nothing scope-wide**: `mintPrincipal()` with no permissions
 * gets no role at all, so the only authority it ever has is the grant this suite
 * makes on one instance. A pass therefore means the grant is what let it in.
 *
 * The other six operations are out of scope here and deliberately not reported
 * as gaps: five check the node (a template belongs to the scope; the ingress pair
 * speaks for a provider and arrives with a request id, not an instance), and
 * `protocol/list-for-entity` declares `narrows` because the entity it checks
 * against has a type that arrives as data.
 */
import { afterAll, beforeAll } from 'vitest';
import { permissionKey, type EntityRef, type PrincipalId } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import type { ScopeStub } from '@substrat-run/kernel';
import { PROTOCOL_PERM as PERM, protocolModule } from '../src/index.js';
import { protocolOperations } from '../src/operations.js';

const CONTENT = {
  sections: [
    {
      title: 'Broms',
      items: [{ key: 'front-brake', label: 'Frambroms', type: 'check' as const }],
    },
  ],
};

let h: EngineHarness;
let staff: ScopeStub;
let probe: { principal: PrincipalId; stub: ScopeStub };
let n = 0;

beforeAll(async () => {
  h = await engineHarness({
    modules: [protocolModule],
    // The engine has never heard of a work order; the harness plays the
    // vertical's part, as engine-protocol's own suite does.
    entityRelations: [{ entityType: 'protocol', parentType: 'workorder' }],
    connections: ['scrive'],
    attachments: true,
  });
  staff = await h.as([PERM.create, PERM.read]);
  // No permissions at all — no role, no tuples. Everything this principal can
  // ever do arrives as a grant on one instance.
  probe = await h.mintPrincipal();
  await staff.invoke('protocol/define-template', {
    key: 'self-inspection',
    title: 'Self-inspection',
    content: CONTENT,
  });
});

afterAll(async () => {
  await h.close();
});

entityCheckConformanceSuite(
  'engine-protocol',
  protocolOperations,
  async () => ({
    async createEntity(entityType: string) {
      if (entityType !== 'protocol') throw new Error(`no factory for '${entityType}'`);
      // A fresh parent each time: the engine allows one OPEN instance per
      // (template, entity), so reusing one work order would refuse the second.
      const instance = await staff.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'self-inspection',
        entityType: 'workorder',
        entityId: `01JWORKORDER${String(n++).padStart(15, '0')}`,
      });
      return instance.id;
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      await h.grantOn(probe.principal, permissionKey.parse(permission), entity);
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      return probe.stub.invoke(operation, input);
    },
  }),
  {
    // Only what each schema REQUIRES beyond `instanceId`. These need to be
    // plausible, not domain-valid: case 1 asserts "was not denied", and a
    // business refusal on a fresh checklist instance is not a permission answer.
    // `protocol/list-for-entity` narrows to the entity its CALLER names, and an
    // engine cannot enumerate its callers' nouns — so the type field is an open
    // `z.string()` and the kit will not invent a value for it (#896). Reported
    // here rather than left out of scope: it is a real narrowed check that is not
    // being driven, which is exactly what this list is for.
    uncovered: {
      'protocol/list-for-entity':
        "declares 'entityFrom: entityType', whose schema does not enumerate the types it " +
        'admits — the kit cannot know which entity to create, and will not guess one',
    },
    inputs: {
      'protocol/fill': { itemKey: 'front-brake', value: true },
      'protocol/bind-document': {
        contentRef: { entityType: 'workorder', entityId: '01JWORKORDER000000000000000' },
        contentHash: 'a'.repeat(64),
      },
      'protocol/request-signatures': {
        method: 'scrive',
        // One party, and it is the ISSUER — the only kind that needs no delivery
        // address, so the fixture carries no contact detail at all.
        parties: [{ label: 'Beställare', kind: 'external', signatureKind: 'primary' }],
      },
      'protocol/cancel-signatures': { reason: 'conformance' },
      'protocol/void': { reason: 'conformance' },
    },
  },
);
