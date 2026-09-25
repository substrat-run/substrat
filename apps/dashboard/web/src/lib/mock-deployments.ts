import type { AppDeployments, AppModelView, ChannelHistoryEntry, ReleaseComparison, ReleasesView } from './api';
import { MOCK_APP_MODEL, MOCK_DEPLOYMENTS } from './mock';

/**
 * Dev-preview fixtures for the Deployments tab (#1767), all about the helpdesk that
 * `MOCK_DEPLOYMENTS[0]` describes: this app runs 0.2.0, prod is on 0.3.0, and 0.4.0-beta.7
 * went live for six minutes before prod was moved back — the rollback the Releases list
 * has to show. Kept apart from `mock.ts` so the fixtures agree with each other here.
 */

const helpdesk = MOCK_DEPLOYMENTS[0]!;
const V = {
  v400: '01J2Q8Z3V9K4W7X2M5N6P7V400',
  v300: '01J2Q8Z3V9K4W7X2M5N6P7V300',
  v200: '01J2Q8Z3V9K4W7X2M5N6P7V200',
  v100: '01J2Q8Z3V9K4W7X2M5N6P7V100',
  v050: '01J2Q8Z3V9K4W7X2M5N6P7V050',
};

/** The tab's registry read. 0.4.0-beta.7 is admitted here — it was promoted, so it must have been. */
export const MOCK_APP_DEPLOYMENTS: AppDeployments = {
  ...helpdesk,
  versions: helpdesk.versions.map((v) => (v.id === V.v400 ? { ...v, admission: 'admitted' } : v)),
  nextCursor: null,
};

/** Prod's moves, newest first: 0.4.0-beta.7 live at 09:36, back to 0.3.0 at 09:42. */
export const MOCK_PROD_HISTORY: ChannelHistoryEntry[] = [
  { id: '01J2Q8Z3V9K4W7X2M5N6P7H005', versionId: V.v300, fromVersionId: V.v400, actor: 'dana@acme.com', at: '2026-07-23T09:42:00Z' },
  { id: '01J2Q8Z3V9K4W7X2M5N6P7H004', versionId: V.v400, fromVersionId: V.v300, actor: 'dana@acme.com', at: '2026-07-23T09:36:00Z' },
  { id: '01J2Q8Z3V9K4W7X2M5N6P7H003', versionId: V.v300, fromVersionId: V.v200, actor: 'jonas@acme.com', at: '2026-07-22T12:14:00Z' },
  { id: '01J2Q8Z3V9K4W7X2M5N6P7H002', versionId: V.v200, fromVersionId: V.v050, actor: 'jonas@acme.com', at: '2026-07-20T12:08:00Z' },
  { id: '01J2Q8Z3V9K4W7X2M5N6P7H001', versionId: V.v050, fromVersionId: null, actor: 'dana@acme.com', at: '2026-07-16T12:30:00Z' },
];

const row = (versionId: string, patch: Partial<ReleasesView['releases'][number]>): ReleasesView['releases'][number] => {
  const v = helpdesk.versions.find((x) => x.id === versionId)!;
  return {
    versionId,
    version: v.version,
    pushedAt: v.createdAt,
    origin: v.origin?.source ?? null,
    schemaChange: !!v.schemaChange,
    wentLiveAt: null,
    isProd: false,
    isServing: false,
    scopesPinned: 0,
    failures: 0,
    requests: null,
    errors: null,
    ...patch,
  };
};

/** The release ledger: four live installs — two follow prod, one pinned to 0.2.0 (this app), one to 0.0.5. */
export const MOCK_APP_RELEASES: ReleasesView = {
  releases: [
    row(V.v400, { wentLiveAt: '2026-07-23T09:36:00Z', failures: 3 }),
    row(V.v300, { wentLiveAt: '2026-07-23T09:42:00Z', isProd: true, isServing: true }),
    row(V.v200, { wentLiveAt: '2026-07-20T12:08:00Z', scopesPinned: 1 }),
    row(V.v100, {}),
    row(V.v050, { wentLiveAt: '2026-07-16T12:30:00Z', scopesPinned: 1 }),
  ],
  scopesTrackingProd: 2,
  metricsAvailable: true,
};

/** Running 0.2.0 vs the 0.3.0 an update moves to — the same pair the Permissions mock diffs. */
export const MOCK_APP_RELEASE_COMPARISON: ReleaseComparison = {
  running: { versionId: V.v200, version: '0.2.0', requests: 412, errors: 9, cpuTimeP50: 3.9, cpuTimeP99: 17.4 },
  update: { versionId: V.v300, version: '0.3.0', requests: 3344, errors: 4, cpuTimeP50: 4.2, cpuTimeP99: 19.8 },
  metricsAvailable: true,
  owned: true,
};

/** The model pair behind the Schema column: 0.3.0 adds a priority and makes the subject optional. */
export const MOCK_APP_MODEL_UPDATE: AppModelView = (() => {
  const running = MOCK_APP_MODEL.running;
  const entities = running.model!.entities;
  const ticket = entities.ticket!;
  const fields = ticket.fields as { properties: Record<string, unknown>; required: string[] };
  return {
    running,
    update: {
      versionId: V.v300,
      version: '0.3.0',
      model: {
        ...running.model!,
        entities: {
          ...entities,
          ticket: {
            ...ticket,
            fields: {
              ...fields,
              properties: { ...fields.properties, priority: { enum: ['low', 'normal', 'urgent'] } },
              required: fields.required.filter((f) => f !== 'subject'),
            },
          },
        },
      },
    },
  };
})();
