/**
 * Protocol's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { protocolOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'engine-protocol',
  operations: protocolOperations,
  // Only what each schema REQUIRES beyond `instanceId`. These need to be
  // plausible, not domain-valid: case 1 asserts "was not denied", and a
  // business refusal on a fresh checklist instance is not a permission answer.
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
});
