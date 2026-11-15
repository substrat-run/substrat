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
 * kernel's one rule (`resolvePeerInstanceFrom`: same tenant, primary, active, bound or exactly one), and the
 * call goes through the target's peer door (`getVerticalScope`), whose admission and checks are
 * the ones a hosted call meets. On the hosted path the router plays this part, from facts the
 * calling deployment cannot influence.
 *
 * **What it deliberately cannot do.** Name a tenant (the target is searched in the caller's own
 * tenant only), name a principal (there is no parameter for one: a peer acts as itself), or reach
 * a preview (never resolved as a target, and refused as a caller).
 *
 * **A call made for a person (#3161).** `onBehalf` carries a delegated token, which is still not
 * the caller naming anyone: the TARGET's harness verifies it (`delegated`, its person contract's
 * door), and only a token it admits makes the call run as that person, with the token's `scope`
 * as the ceiling. Such a call does not pass the peer door, since it is not the calling vertical
 * acting. The token is never logged or echoed in an error.
 */
import {
  PEER_CLIENT_OPERATION,
  peerOnBehalf,
  platformActorId,
  scopeId as scopeIdOf,
  substratError,
  tenantId as tenantIdOf,
  verticalSlug,
  type PeerClientAnswer,
  type PlatformActorId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { isPrimaryScope, resolvePeerInstanceFrom, type InvokeOptions } from '@substrat-run/kernel';
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

/** `invoke`'s options: the target scope's own, and the person a call may be made for (#3161). */
export interface LocalVerticalInvokeOptions extends InvokeOptions {
  /** A delegated token for the target, as `peerCallRequest.onBehalf` carries it. */
  onBehalf?: { token: string };
}

/** What a calling harness holds: calls out as ONE scope of ONE vertical, and nothing else. */
export interface LocalVerticalClient {
  /**
   * Invoke `operation` on the instance of vertical `target` in the caller's tenant, as the
   * caller. Throws `forbidden` when the caller is not a live primary instance or the target's
   * door refuses it, `not_found` when the target is not installed in the tenant, `conflict`
   * when the tenant runs more than one instance without a choice, or a choice is unavailable.
   *
   * With `onBehalf`, as the person the token names instead (#3161): `forbidden` when the target
   * takes no delegated calls, `permission_denied` when its door does not admit the token, and
   * `unavailable` when that door could not ask the app it takes its people from.
   */
  invoke<O = unknown>(target: string, operation: string, input?: unknown, options?: LocalVerticalInvokeOptions): Promise<O>;
}

/** What the target's harness answers for a call made for a person: its person contract's door. */
export type LocalDelegatedAnswer =
  | { admitted: true; principal: PrincipalId; scope: string[]; actor: string }
  | { admitted: false; reason: string };

/** Per target vertical: what the platform layer in front of its scopes answers (#3161). */
export interface LocalVerticalTargetHooks {
  /** The target's OIDC client, the answer to `PEER_CLIENT_OPERATION`. Absent answers null. */
  clientId?: string;
  /** Who a call carrying `onBehalf` is made for. Absent: the target takes no delegated calls. */
  delegated?: (call: {
    token: string;
    caller: LocalVerticalCallerRef;
    target: { tenantId: TenantId; scopeId: ScopeId };
  }) => Promise<LocalDelegatedAnswer>;
}

export interface LocalVerticalBroker {
  /** A client that speaks as `from` — the harness's own scope, and only that. */
  clientFor(from: LocalVerticalCallerRef): LocalVerticalClient;
  /**
   * Harness-owned choice across the caller and target hosts' separate directories.
   * Choices are in memory and disappear when this broker is recreated or the process restarts.
   */
  setBinding(from: LocalVerticalCallerRef, target: string, targetScopeId: ScopeId | null): Promise<void>;
}

/**
 * Stand two (or more) verticals side by side on the pure host, each on its own `SqliteScopeHost`
 * — one vertical's code per host, as one script per vertical in production — keyed by registry
 * slug. Each host holds its own directory, so the tenant a test or dev harness provisions must be
 * created on every host that serves one of its instances.
 */
export function createLocalVerticalBroker(
  hosts: Readonly<Record<string, SqliteScopeHost>>,
  /** Keyed by the target's registry slug, as `hosts` is. */
  targets: Readonly<Record<string, LocalVerticalTargetHooks>> = {},
): LocalVerticalBroker {
  const hostOf = (vertical: string): SqliteScopeHost | undefined =>
    Object.prototype.hasOwnProperty.call(hosts, vertical) ? hosts[vertical] : undefined;
  const hooksOf = (vertical: string): LocalVerticalTargetHooks | undefined =>
    Object.prototype.hasOwnProperty.call(targets, vertical) ? targets[vertical] : undefined;
  // The broker is one in-process harness spanning hosts; no individual host directory has
  // both endpoints. Production's directory keeps this row durably instead.
  const bindings = new Map<string, { targetScopeId: ScopeId; invalidated: boolean; archiveRevision: string | null }>();
  const bindingKey = (from: LocalVerticalCallerRef, target: string) =>
    JSON.stringify([from.tenantId, from.scopeId, target]);
  const archiveRevision = async (host: SqliteScopeHost, tenantId: TenantId, scopeId: ScopeId) =>
    (await host.admin.auditLog(LOCAL_BROKER_ACTOR, {
      tenantId, scopeId, action: ['archiveScope', 'reapScope', 'deleteSnapshot'], order: 'desc', limit: 1,
    }))[0]?.id ?? null;

  return {
    async setBinding(from, target, targetScopeId) {
      const caller = {
        vertical: verticalSlug.parse(from.vertical),
        tenantId: tenantIdOf.parse(from.tenantId),
        scopeId: scopeIdOf.parse(from.scopeId),
      };
      const target_ = verticalSlug.parse(target);
      const selected = targetScopeId === null ? null : scopeIdOf.parse(targetScopeId);
      const record = await hostOf(caller.vertical)?.admin.getScopeRecord(LOCAL_BROKER_ACTOR, caller.tenantId, caller.scopeId);
      if (!record || record.vertical !== caller.vertical || record.status !== 'active' || !isPrimaryScope(record)) {
        throw substratError('not_found', 'calling app is not a live primary scope in this tenant');
      }
      if (selected !== null) {
        const candidate = await hostOf(target_)?.admin.getScopeRecord(LOCAL_BROKER_ACTOR, caller.tenantId, selected);
        if (!candidate || candidate.vertical !== target_ || candidate.status !== 'active' || !isPrimaryScope(candidate)) {
          throw substratError('not_found', 'target is not a live primary instance of this vertical in this tenant');
        }
      }
      const key = bindingKey(caller, target_);
      if (selected === null) bindings.delete(key);
      else bindings.set(key, {
        targetScopeId: selected,
        invalidated: false,
        archiveRevision: await archiveRevision(hostOf(target_)!, caller.tenantId, selected),
      });
    },
    clientFor(from) {
      const caller = {
        vertical: verticalSlug.parse(from.vertical),
        tenantId: tenantIdOf.parse(from.tenantId),
        scopeId: scopeIdOf.parse(from.scopeId),
      };
      return {
        async invoke<O>(target: string, operation: string, input?: unknown, options?: LocalVerticalInvokeOptions): Promise<O> {
          const { onBehalf, ...invokeOptions } = options ?? {};
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
          const tenant = await callerHost!.admin.getTenant(LOCAL_BROKER_ACTOR, caller.tenantId);
          if (tenant?.status !== 'active' || record.status !== 'active' || !isPrimaryScope(record)) {
            throw substratError(
              'forbidden',
              `scope ${caller.scopeId} of '${caller.vertical}' may not call other verticals: it is ` +
                (tenant?.status !== 'active' ? `in a ${tenant?.status ?? 'missing'} tenant` : record.status !== 'active' ? `${record.status}` : 'a preview or a fork') +
                ' — only a live primary instance acts as its vertical',
            );
          }
          // 2. The target, by slug, in the CALLER's tenant only — the kernel's one rule.
          const target_ = verticalSlug.parse(target);
          const targetHost = hostOf(target_);
          const scopes = targetHost
            ? await targetHost.admin.listScopes(LOCAL_BROKER_ACTOR, { tenantId: caller.tenantId, vertical: target_ })
            : [];
          const binding = bindings.get(bindingKey(caller, target_));
          // The immutable audit ID catches even an archive and unarchive between calls.
          // Suspension changes no archive revision, so it refuses only while suspended.
          if (binding && !binding.invalidated) {
            const chosen = scopes.find((scope) => scope.id === binding.targetScopeId);
            if (!chosen || chosen.status === 'archived' || !targetHost ||
              await archiveRevision(targetHost, caller.tenantId, binding.targetScopeId) !== binding.archiveRevision) {
              binding.invalidated = true;
            }
          }
          // Exact names (`slug: null`): local verticals register under their bare slug and each
          // has its own host keyed by it, so no tenant-pinned spelling exists to reach (#2252).
          const resolution = resolvePeerInstanceFrom(
            scopes, { id: caller.tenantId, slug: null }, target_, binding?.targetScopeId ?? null, binding?.invalidated ?? false,
          );
          if (resolution.outcome === 'not-installed') {
            throw substratError('not_found', `vertical '${target_}' is not installed in this tenant`);
          }
          if (resolution.outcome === 'bound-unavailable') {
            throw substratError('conflict', `the bound instance of '${target_}' is unavailable; rebind or clear this app's peer binding`);
          }
          if (resolution.outcome === 'ambiguous') {
            throw substratError(
              'conflict',
              `this tenant runs ${resolution.count} instances of '${target_}' — a call cannot pick one; ` +
                'bind the instance first',
            );
          }
          const at = { tenantId: resolution.instance.tenantId, scopeId: resolution.instance.scopeId };
          const hooks = hooksOf(target_);
          // 3a. The platform layer's own answer (#3161), before any module or `peers` lookup: to a
          //     caller that got this far, as the router answers any peer it dispatches. A client
          //     id is no secret; every token the target's sign-in hands out names it.
          if (operation === PEER_CLIENT_OPERATION) {
            return { clientId: hooks?.clientId ?? null } satisfies PeerClientAnswer as O;
          }
          // 3b. A call made for a person: the target's own door says who, and the call runs as
          //     them under the token's scope. Not the peer door: the calling vertical is not acting.
          if (onBehalf !== undefined) {
            // Parsed for the transport's bound; the refusal echoes nothing of what was sent.
            if (!peerOnBehalf.safeParse(onBehalf).success) {
              throw substratError('validation_failed', 'onBehalf: expected { token } with a token of 1–8192 characters');
            }
            if (!hooks?.delegated) {
              throw substratError('forbidden', `vertical '${target_}' takes no calls made for a person`);
            }
            const answer = await hooks.delegated({ token: onBehalf.token, caller: { ...caller }, target: at });
            if (!answer.admitted) {
              throw answer.reason === 'unavailable'
                ? substratError('unavailable', `vertical '${target_}' could not say who this call is made for`)
                : substratError('permission_denied', `vertical '${target_}' did not admit the person this call is made for (${answer.reason})`);
            }
            const stub = await targetHost!.getScope(answer.principal, at.tenantId, at.scopeId, {
              delegation: { actor: answer.actor, scope: answer.scope },
            });
            return stub.invoke<O, unknown>(operation, input, invokeOptions);
          }
          // 3c. The target's peer door, as the caller — admission and every check happen there.
          const stub = await targetHost!.getVerticalScope(
            { vertical: caller.vertical, scope: caller.scopeId },
            at.tenantId,
            at.scopeId,
          );
          return stub.invoke<O, unknown>(operation, input, invokeOptions);
        },
      };
    },
  };
}
