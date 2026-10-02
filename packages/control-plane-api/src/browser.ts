/**
 * The browser-safe entry (`@substrat-run/control-plane-api/browser`, #971): the typed
 * client a staff console runs in a page, and the types it renders. Everything reachable
 * from here is `fetch` + `@substrat-run/contracts` + type-only imports — never `hono`,
 * never a Node builtin — so a bundler can follow it without pulling the server in.
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
  RecentLogEvent,
  ScopeHealth,
  ServiceMetricsRow,
  StaffMember,
  SweepRunsQuery,
  SystemSwitchesQuery,
  TenantStores,
} from './staff-client.js';
export { ControlPlaneError } from './transport.js';
export type { ControlPlaneTransportOptions } from './transport.js';
