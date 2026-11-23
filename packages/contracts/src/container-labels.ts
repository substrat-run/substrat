/**
 * The labels the platform puts on a Cloudflare Container it starts for a tenant (#3316), and the
 * only way the daily cost rollup can tell whose a container's usage is.
 *
 * Cloudflare's container usage (`containersUsageAdaptiveGroups`) names an application and an
 * instance, never a tenant: the builder's sandboxes all run in one application. A label set at
 * start is a grouping dimension of that dataset (`label(name: …)`), so the rollup reads usage per
 * tenant label and charges it to that tenant. A container started without one is the platform's.
 *
 * Cloudflare's limits: at most 10 labels, a name of 1 to 16 bytes, a value of at most 64 bytes, no
 * control characters. A start with a label past them throws, so a value that does not fit is left
 * out rather than cut: a truncated slug would name another app.
 */

/** The tenant a container runs for: its tenant id. */
export const CONTAINER_TENANT_LABEL = 'substrat-tenant';
/** The app (vertical slug) a container works on, when it has one that fits. */
export const CONTAINER_APP_LABEL = 'substrat-app';

/**
 * How many days back Cloudflare answers container usage ("cannot request data older than 4w4d"),
 * far fewer than the Workers and Durable Object datasets' 90: a cost day older than this is read
 * without containers rather than not read at all.
 */
export const CONTAINER_USAGE_RETENTION_DAYS = 31;

/** The longest label value Cloudflare accepts, in bytes. */
export const CONTAINER_LABEL_VALUE_MAX_BYTES = 64;

const fits = (value: string): boolean =>
  value.length > 0 &&
  new TextEncoder().encode(value).length <= CONTAINER_LABEL_VALUE_MAX_BYTES &&
  [...value].every((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f);

/**
 * The labels for a container started for `tenantId`, working on `app` when there is one. A value
 * that would not fit Cloudflare's limits is left out, so a start never throws on a label.
 */
export function containerLabels(tenantId: string, app?: string | null): Record<string, string> {
  const labels: Record<string, string> = {};
  if (fits(tenantId)) labels[CONTAINER_TENANT_LABEL] = tenantId;
  if (app && fits(app)) labels[CONTAINER_APP_LABEL] = app;
  return labels;
}
