import { LIST_PAGE_MAX } from '@substrat-run/contracts';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { Api } from './api';

/**
 * Creating one instance of a vertical, as a sequence rather than a component.
 *
 * The ORDER is the load-bearing part, so it lives here where it can be tested. A
 * dialog can be re-laid-out freely; this sequence cannot be reordered without
 * breaking a property something else depends on:
 *
 *   1. tenant     — the directory root everything hangs from
 *   2. scope      — the directory row, written as `provisioning`: recorded, and
 *                   unusable until something confirms the vertical built it
 *   3. instance   — the VERTICAL provisions, because only it can create a usable scope
 *                   DO: the class bundles the modules and lives in its deployment (K-31)
 *   4. activate   — the confirmation. `getScope` refuses anything not active, so a row
 *                   whose vertical never ran is inert rather than misleading
 *   5. hostname   — bound, not yet serving
 *   6. activate   — the hostname, last, because it must never resolve before the thing
 *                   behind it exists (K-26)
 *
 * Directory BEFORE vertical, which is the correction: the earlier order wrote the row
 * last so a failure left an "invisible orphan", and invisible is exactly the problem —
 * nothing can reconcile what nothing knows about. A row stuck in `provisioning` is a
 * work item a sweep can find and retry (#49).
 */

export const INSTANCE_STEPS = [
  { key: 'tenant', label: 'Create tenant' },
  { key: 'scope', label: 'Record the scope' },
  { key: 'instance', label: 'Provision instance in the vertical' },
  { key: 'activateScope', label: 'Activate the scope' },
  { key: 'bindVersion', label: 'Pin the scope to the prod version' },
  { key: 'hostname', label: 'Bind the hostname' },
  { key: 'activate', label: 'Activate' },
] as const;

export type InstanceStep = (typeof INSTANCE_STEPS)[number]['key'];

export interface CreateInstanceInput {
  verticalSlug: string;
  slug: string;
  name: string;
  /**
   * Fixed at provisioning and never editable after (K-7). Defaults to `global`,
   * the only value the control plane accepts until `eu`/`us` enforcement exists
   * (K-32).
   */
  jurisdiction?: 'eu' | 'us' | 'global';
  /** Optional. Without one the instance exists and is unreachable. */
  hostname?: string;
  /** Ids are caller-minted so every call is idempotent on retry (§4.1). */
  tenantId: TenantId;
  scopeId: ScopeId;
  owner: PrincipalId;
}

export interface CreateInstanceResult {
  tenantId: TenantId;
  scopeId: ScopeId;
  url: string | null;
}

/**
 * Thrown with the step that failed still attached.
 *
 * "It failed" is not actionable for a multi-step create spanning two systems:
 * whether the vertical provisioned before the directory row did is the difference
 * between an invisible orphan and a tenant that looks real and does not work.
 */
export class InstanceStepError extends Error {
  constructor(
    readonly step: InstanceStep,
    readonly cause: Error,
  ) {
    super(`${INSTANCE_STEPS.find((s) => s.key === step)!.label}: ${cause.message}`);
    this.name = 'InstanceStepError';
  }
}

export async function createInstance(
  api: Api,
  input: CreateInstanceInput,
  onStep?: (step: InstanceStep, state: 'doing' | 'done') => void,
): Promise<CreateInstanceResult> {
  const { tenantId, scopeId, owner, slug, name } = input;
  const verticalSlug = input.verticalSlug.trim();
  const hostname = input.hostname?.trim().toLowerCase() ?? '';

  async function step<T>(key: InstanceStep, fn: () => Promise<T>): Promise<T> {
    onStep?.(key, 'doing');
    try {
      const out = await fn();
      onStep?.(key, 'done');
      return out;
    } catch (e) {
      throw new InstanceStepError(key, e as Error);
    }
  }

  await step('tenant', () => api.createTenant({ id: tenantId, slug, name }));
  await step('scope', () =>
    api.provisionScope({
      tenantId,
      scopeId,
      slug,
      name,
      vertical: verticalSlug,
      jurisdiction: input.jurisdiction ?? 'global',
    }),
  );
  await step('instance', () =>
    api.provisionInstance(verticalSlug, { tenantId, scopeId, owner, slug, name }),
  );
  await step('activateScope', () => api.activateScope(tenantId, scopeId));

  // Pin the scope to the vertical's prod version, so the router dispatches on it
  // (orchestration.md §5.4). A vertical with no promoted version — a static-binding
  // one, or one not yet promoted — has nothing to pin; the scope then serves via the
  // router's static-binding fallback, so this is a no-op rather than an error.
  await step('bindVersion', async () => {
    // One max page IS the full set: channels are a bounded, named handful
    // (dev/staging/prod), nowhere near LIST_PAGE_MAX — no walk loop needed
    // to keep "find prod" a whole-set computation.
    const { entries: channels } = await api.listChannels(verticalSlug, { limit: LIST_PAGE_MAX });
    const prod = channels.find((c) => c.channel === 'prod');
    if (prod) await api.bindScopeVersion(tenantId, scopeId, prod.versionId);
  });

  if (!hostname) return { tenantId, scopeId, url: null };

  await step('hostname', () =>
    api.bindHostname({
      hostname,
      tenantId,
      scopeId,
      surface: 'app',
      region: null,
      canonical: true,
    }),
  );
  await step('activate', () => api.setHostnameStatus(hostname, 'active'));

  return { tenantId, scopeId, url: `https://${hostname}` };
}
