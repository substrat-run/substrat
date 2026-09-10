/**
 * Tock's entity-check claim, in the one place both the test and the trust page read it.
 *
 * Seven operations here take an entity-narrowed permission (`run`, by `runId`) and the kit can
 * exercise every one of them. The rest are scope-wide reads and writes: there is no entity to
 * narrow to when the caller is declaring a source, saving a schema, opening a run or asking
 * for a report over a whole source, so those are out of scope for this suite rather than
 * uncovered by it.
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
    'tock/map-run': { schemaVersion: 1 },
  },
  uncovered: {
    'tock/declare-source': 'scope-wide — a source is what would be the entity, and it does not exist yet',
    'tock/list-sources': 'scope-wide read over every source in the workspace',
    'tock/save-schema': 'scope-wide — narrowing modelling to one source is a design this vertical does not have',
    'tock/list-schemas': 'scope-wide read; the source is a filter, not a permission boundary',
    'tock/receive-run': 'scope-wide — the run is created BY this operation, so there is no entity to check first',
    'tock/list-runs': 'scope-wide read over a source rather than over one run',
    'tock/deviations': "scope-wide read over a source's whole observation history",
    'tock/field-history': 'scope-wide read over a source, deliberately outliving the runs it came from',
    'tock/report': 'scope-wide read over a source; a report that needed a run id would not be a report',
  },
});
