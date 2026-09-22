/**
 * The LOCAL peer broker (#1706) — the pure host's stand-in for the platform hop that says which
 * vertical is calling. DEV AND TEST ONLY, and built so it cannot be anything else:
 *
 * - It is an in-process object, not an endpoint. Nothing reaches it over a network; code reaches
 *   it only by importing it, and it takes the pure host (`SqliteScopeHost`, better-sqlite3) as its
 *   input — which no Workers bundle can carry.
 * - It is exported from its own subpath, `@substrat-run/adapter-sqlite/vertical-broker`, whose
 *   `workerd` / `worker` / `browser` conditions resolve to nothing, so a worker build that imports
 *   it fails to resolve rather than shipping it.
 * - `node tools/boundary-lint.mjs` (R9) refuses the import anywhere but a test or a node harness
 *   (`server.ts`, `seed.ts`, `dev.ts`, `scripts/`), so a `worker.ts` or module code that names it
 *   is red before it builds.
 *
 * **What asserts the caller here.** The harness that wires the broker: it builds one client per
 * calling scope with `clientFor`, and that client can only ever speak as that scope. In a dev
 * process the harness IS the whole trust domain — the same stance as `@substrat-run/dev-issuer`'s
 * `/dev/token`. What the broker keeps identical to production is everything else: the caller must
 * be a live, primary instance of its vertical in the tenant, the target is resolved by the
 * kernel's one rule (`resolveVerticalInstance`: same tenant, primary, active, exactly one), and the
 * call goes through the target's peer door (`getVerticalScope`), whose admission and checks are
 * the ones a hosted call meets. On the hosted path the router plays this part, from facts the
 * calling deployment cannot influence.
 *
 * **What it deliberately cannot do.** Name a tenant (the target is searched in the caller's own
 * tenant only), name a principal (there is no parameter for one: a peer acts as itself), or reach
 * a preview (never resolved as a target, and refused as a caller).
 */
import {
  platformActorId,
  scopeId as scopeIdOf,
  substratError,
  tenantId as tenantIdOf,
  verticalSlug,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { isPrimaryScope, type InvokeOptions } from '@substrat-run/kernel';
import type { SqliteScopeHost } from './index.js';

/** The platform actor the broker reads the directory as — the platform, on the pure host. */
export const LOCAL_BROKER_ACTOR: PlatformActorId = platformActorId.parse('01JZ00000000000000PEERBRKR');

/** A calling scope, as the harness that owns it names it. */
export interface LocalVerticalCallerRef {
  /** The calling vertical's registry slug — a key of the broker's host map. */
  vertical: string;
  tenantId: TenantId;
  scopeId: ScopeId;
}

/** What a calling harness holds: calls out as ONE scope of ONE vertical, and nothing else. */
export interface LocalVerticalClient {
  /**
   * Invoke `operation` on the instance of vertical `target` in the caller's tenant, as the
   * caller. Throws `forbidden` when the caller is not a live primary instance or the target's
   * door refuses it, `not_found` when the target is not installed in the tenant, `conflict`
   * when the tenant runs more than one instance of it.
   */
  invoke<O = unknown>(target: string, operation: string, input?: unknown, options?: InvokeOptions): Promise<O>;
}

export interface LocalVerticalBroker {
  /** A client that speaks as `from` — the harness's own scope, and only that. */
  clientFor(from: LocalVerticalCallerRef): LocalVerticalClient;
}

/**
 * Stand two (or more) verticals side by side on the pure host, each on its own `SqliteScopeHost`
 * — one vertical's code per host, as one script per vertical in production — keyed by registry
 * slug. Each host holds its own directory, so the tenant a test or dev harness provisions must be
 * created on every host that serves one of its instances.
 */
export function createLocalVerticalBroker(hosts: Readonly<Record<string, SqliteScopeHost>>): LocalVerticalBroker {
  const hostOf = (vertical: string): SqliteScopeHost | undefined =>
    Object.prototype.hasOwnProperty.call(hosts, vertical) ? hosts[vertical] : undefined;

  return {
    clientFor(from) {
      const caller = {
        vertical: verticalSlug.parse(from.vertical),
        tenantId: tenantIdOf.parse(from.tenantId),
        scopeId: scopeIdOf.parse(from.scopeId),
      };
      return {
        async invoke<O>(target: string, operation: string, input?: unknown, options?: InvokeOptions): Promise<O> {
          // 1. The caller, re-read from ITS host's directory on every call: a live, primary
          //    instance of the vertical it says it is, in the tenant it says. Suspended,
          //    archived, forked, preview — all refused here, before any target is looked up.
          //    This is the router's per-call gate; nothing downstream re-checks it.
          const callerHost = hostOf(caller.vertical);
          const record = await callerHost?.admin.getScopeRecord(LOCAL_BROKER_ACTOR, caller.tenantId, caller.scopeId);
          if (!record || record.vertical !== caller.vertical) {
            throw substratError(
              'forbidden',
              `scope ${caller.scopeId} is not an instance of '${caller.vertical}' in this tenant — a peer ` +
                'call is made by a live instance of the calling vertical',
            );
          }
          if (record.status !== 'active' || !isPrimaryScope(record)) {
            throw substratError(
              'forbidden',
              `scope ${caller.scopeId} of '${caller.vertical}' may not call other verticals: it is ` +
                (record.status !== 'active' ? `${record.status}` : 'a preview or a fork') +
                ' — only a live primary instance acts as its vertical',
            );
          }
          // 2. The target, by slug, in the CALLER's tenant only — the kernel's one rule.
          const target_ = verticalSlug.parse(target);
          const targetHost = hostOf(target_);
          const resolution = targetHost
            ? await targetHost.admin.resolveVerticalInstance(caller.tenantId, target_)
            : ({ outcome: 'not-installed', tenantId: caller.tenantId, vertical: target_ } as const);
          if (resolution.outcome === 'not-installed') {
            throw substratError('not_found', `vertical '${target_}' is not installed in this tenant`);
          }
          if (resolution.outcome === 'ambiguous') {
            throw substratError(
              'conflict',
              `this tenant runs ${resolution.count} instances of '${target_}' — a call cannot pick one; ` +
                'bind the instance first',
            );
          }
          // 3. The target's peer door, as the caller — admission and every check happen there.
          const stub = await targetHost!.getVerticalScope(
            { vertical: caller.vertical, scope: caller.scopeId },
            resolution.instance.tenantId,
            resolution.instance.scopeId,
          );
          return stub.invoke<O, unknown>(operation, input, options);
        },
      };
    },
  };
}
