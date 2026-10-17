/**
 * The browser-safe entry (`@substrat-run/control-plane-api/browser`, #971): the typed
 * client a staff console runs in a page, and the types it renders. Everything reachable
 * from here is `fetch` + `@substrat-run/contracts` + `@substrat-run/control-plane-client`
 * (itself only those two) + type-only imports — never `hono`, never a Node builtin — so a
 * bundler can follow it without pulling the server in.
 * `test/browser-entry.test.ts` holds that line.
 */
export { ControlPlaneStaffClient } from './staff-client.js';
export type {
  AdminLogPage,
  AuditLogQuery,
  BindHostnameInput,
  ConnectionHealthQuery,
  ConnectorCallsBucket,
  DoNamespace,
  EgressReport,
  IssuesQuery,
  MembersReading,
  ObservedEgressRow,
  OpsFailuresQuery,
  PageQuery,
  PlatformRuntime,
  ProvisionScopeInput,
  RebindScopeResult,
  RebindReviewResult,
  RecentLogEvent,
  ReprovisionedScope,
  ScopeHealth,
  ServiceMetricsRow,
  StaffMember,
  SweepRunsQuery,
  SystemSwitchesQuery,
  TenantStores,
} from './staff-client.js';
// #2192: one reading of a request line's outbound calls, for the control plane's request list
// and the dashboard's slide-over alike. `observability.ts` imports nothing.
export { outboundCallsOf } from './observability.js';
export type { OutboundCall } from './observability.js';
// The client package's whole surface, so a caller of either entry reaches it from here and
// no existing import moved (#971). `test/reexports.test.ts` pins that nothing is missing.
export * from '@substrat-run/control-plane-client';
