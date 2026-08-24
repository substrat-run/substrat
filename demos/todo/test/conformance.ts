/**
 * Todo's entity-check claim, in the one place both the test and the trust page
 * read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { todoOperations } from '../spec/model.js';

export const conformance = declareEntityChecks({
  subject: 'todo',
  operations: todoOperations,
  // Only what the schema REQUIRES beyond the list id — the kit reads the input
  // shape and asks for nothing it can supply itself.
  inputs: {
    'todo/rename-list': { name: 'Renamed by the conformance kit' },
    'todo/add-item': { text: 'conformance item' },
    // A real person in the scope, as a literal — the seed's own address. The
    // world is not built when the suite is constructed.
    'todo/share-list': { email: 'ada@example.com' },
    // Any term above the prefix index's two-character floor. What is under test
    // is the entity check, which runs before the index is ever consulted — a
    // term matching nothing still proves Björn was let in or turned away.
    'todo/search-list-items': { q: 'conformance' },
  },
  // `share-list` opens on `list:manage` and honours it, then delegates
  // `list:contribute` to the invitee — and `ctx.grant` only narrows a
  // permission the caller HOLDS. Ada holds both on `owner:ada` through the
  // bootstrap grant, so no real owner ever notices; a principal granted
  // `list:manage` on one list alone is refused by that second gate.
  alsoGrant: {
    'todo/share-list': {
      permissions: ['list:contribute'],
      because:
        'the handler delegates list:contribute to the invitee via ctx.grant, and delegation ' +
        'only narrows a permission the caller already holds',
    },
  },
  // The three the kit cannot generate, and why. Asserted exactly: turning one
  // of the seven above into a `resolved` check fails here until this list says
  // so, which is the coverage loss made visible in the diff.
  //
  // `todo/search-items` is absent because it is out of scope rather than
  // uncovered: it declares `narrows`, so it claims no entity check for this
  // suite to honour. Its walk is proved by the scenario instead.
  uncovered: {
    'todo/set-item-done':
      "declares 'resolved' (the list the item is on) — the entity id is not in the input, " +
      'so the harness cannot reach the entity',
    'todo/delete-item':
      "declares 'resolved' (the list the item is on) — the entity id is not in the input, " +
      'so the harness cannot reach the entity',
    'todo/revoke-share':
      "declares 'resolved' (the list the share is on) — the entity id is not in the input, " +
      'so the harness cannot reach the entity',
  },
});
