/**
 * Manyfold's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { assertNodeOnly } from '@substrat-run/contract-tests/conformance';

export const conformance = assertNodeOnly({
  subject: 'manyfold',
  sources: [new URL('../src/module.ts', import.meta.url).pathname],
  because:
    'Twenty-five checks across `author`, `review`, `publish`, `read`, `admin` and `manage-sites`, ' +
    'every one at the node — the editorial model working as designed. Authority here is a ROLE ' +
    "over the whole workspace, and a document's lifecycle gates who may act on it by its STATE " +
    'rather than by who was granted that particular document. The strong half: `ENTITY_GRANTS` is ' +
    'empty, so a narrowed check would resolve against nothing and deny every caller.',
});
