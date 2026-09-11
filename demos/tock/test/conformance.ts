/**
 * Tock's entity-check claim, in the one place both the test and the trust page read it.
 *
 * Seven operations take an entity-narrowed permission (`run`, by `runId`) and the kit
 * exercises every one of them, in `test/entity-checks.test.ts`. Until that suite existed this
 * file was a claim about coverage with nothing executing it, and the package's green run was
 * the scenario alone.
 *
 * ## `uncovered` is empty, and it is not the list a reader expects
 *
 * The other nine operations — `declare-source`, `list-sources`, `save-schema`,
 * `list-schemas`, `receive-run`, `list-runs`, `deviations`, `field-history` and `report` —
 * take a **scope-wide** permission and declare no entity check at all. There is no entity to
 * narrow to when the caller is opening a run that does not exist yet, or asking for a report
 * over a whole source.
 *
 * They were written into `uncovered` here, which reads right and means something narrower:
 * the kit fills that map with operations that DO declare an entity check and that it cannot
 * drive — a stale `idFrom`, a co-entity naming a field the schema lacks. An operation with no
 * entity check is in neither bucket, so the map has to be empty, and running the suite is what
 * said so.
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { tockOperations } from '../spec/model.js';

export const conformance = declareEntityChecks({
  subject: 'tock',
  operations: tockOperations,
  /**
   * Only what each schema requires beyond `runId` — the kit reads the input shape and asks
   * for nothing it can supply itself.
   */
  inputs: {
    // An empty batch is a legitimate one: what is under test is the entity check, which runs
    // before a single record is looked at, so a batch that would write nothing still proves
    // the caller was let in or turned away.
    'tock/profile-run': { batch: [], final: false },
    // `storageKey` is shape-refined (no absolute paths, no `..`), and the kit cannot invent a
    // value that satisfies a refinement — so the fixture is supplied here rather than the
    // constraint being loosened to keep a generator happy.
    'tock/receive-run': {
      storageKey: 'files/conformance-fixture',
      // The structural mapping is required now, and the kit cannot invent one: which column
      // carries the instant is a judgement about a file, not something a schema implies.
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
    },
    'tock/map-run': { schemaVersion: 1 },
  },
  uncovered: {},
});
