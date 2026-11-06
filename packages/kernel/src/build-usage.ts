/**
 * Build usage: how long a tenant's successful hosted source builds worked (#2946).
 *
 * A row is a build that produced a release. Queue time and failed builds are not in it, so
 * this is what a build could be charged for, not what the platform spent. Nothing prices it yet.
 */
import type { TenantId } from '@substrat-run/contracts';

/** As `MODEL_USAGE_RETENTION_DAYS`: a year of usage plus the month being billed. */
export const BUILD_USAGE_RETENTION_DAYS = 400;

/** What `recordBuildUsage` stores. `buildId` is the dedupe key: a second record writes nothing. */
export interface BuildUsageInput {
	buildId: string;
	tenantId: TenantId;
	vertical: string;
	ms: number;
	at: string;
}

/** One vertical's builds in the window. */
export interface TenantBuildUsageRow {
	vertical: string;
	builds: number;
	ms: number;
}

/** A half-open `[since, until)` window over one tenant. */
export interface TenantBuildUsageFilter {
	tenantId: TenantId;
	since: string;
	until: string;
	limit: number;
}
