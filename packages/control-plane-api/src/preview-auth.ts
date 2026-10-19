import {
  MCP_RESOURCES_CONFIG_PREFIX,
  SHARED_ISSUER_CONFIG_KEY,
  mcpResourceOf,
  oidcCallbackUrl,
  type HostnameBinding,
  type MintedPreviewClient,
  type PlatformActorId,
  type PreviewAuth,
  type Scope,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { VerticalClient } from './vertical-client.js';

/**
 * A preview's login (#1704) — the control plane's half. The issuer's half, and why the
 * protocol has the shape it has, are in `@substrat-run/contracts`' `preview-client.ts`.
 *
 * A fork arrives with the parent's DATA and none of its delivered config: the PR's version
 * is its own script with its own, empty, config store — at create and again after every push,
 * which binds yet another script. The parent's `substrat:auth` carries a client secret the
 * platform neither stores nor reads back, so it cannot be copied either. What CAN be done,
 * when the parent signs in at one of the team's own auth-servers, is to give the preview a
 * client of its own there and deliver THAT. Prod's client is never read, written, or taught a
 * preview's callback.
 *
 * ## Which issuer
 *
 * Nothing the control plane holds says which issuer an app chose — only the dashboard knows,
 * and it tells the ISSUER (#1619's resource rows, #1670's places), never the plane. So every
 * active auth-server of the preview's OWN tenant is asked whether it signs the parent in; a
 * fork or preview of an auth-server is never asked (it holds copies of prod's clients, not
 * the parent's binding). One claim is wired. None is `unregistered` — an external issuer, a
 * builtin login, or an install the dashboard has not registered yet — and more than one is
 * `ambiguous`, which wires nothing rather than guess.
 *
 * ## Concurrent pushes
 *
 * Two pushes to one preview each bind their own version, and each version is its own config
 * store; only the version the preview is bound to NOW is served. So a push:
 *
 *   1. re-reads the binding before it mints, and stops if its version is no longer bound;
 *   2. delivers into ITS OWN version's deployment — never "whatever the scope is bound to",
 *      which would let an older push overwrite a newer push's store;
 *   3. re-reads the binding before it retires anything, and if its version has moved on,
 *      deletes only the client it minted (which lives in its own, unserved, store) and stops;
 *   4. otherwise retires the preview's clients OLDER than its own. `superseded` (a newer one
 *      exists) means stop: the push that minted it owns what happens next. Only `kept: false`
 *      — its own client vanished while its version is still bound — is retried, three
 *      attempts in all; running out is a failure, never a success.
 *
 * ## Its MCP endpoint
 *
 * The issuer that now signs the preview in is also told to mint for the preview's MCP
 * endpoint, or an MCP client pointed at the preview meets `invalid_target` before any login
 * page (#1619). It is the dashboard's own delivery, `substrat:resources:<scope id>` through
 * the issuer's `/internal/configure`, keyed by the PREVIEW's scope: the issuer touches only
 * rows marked for that key, so prod's registration is never read or written. The value is
 * the whole set, so every push re-asserts it at no cost, and the reap clears it. Like the
 * dashboard's registration it is best-effort: a login that works is not failed for it.
 *
 * ## A reap racing a push
 *
 * The reap keeps the preview's row until its very last step, so the row alone cannot tell a
 * push that the preview is going. The reap therefore ARCHIVES it before it touches any issuer
 * (`retireClientsOfReapedScope`), and a push reads anything but `active` as gone. Archived is
 * one-way here: no push ever restores a scope. Every issuer write of a push is followed by
 * one of its looks at the binding before it answers, so either that look came before the
 * archive, and the reap's issuer step, which runs after the archive, removes what the push
 * wrote; or the look sees the archive, and the push removes what it wrote itself.
 *
 * Both removals clear the registration BEFORE they retire the clients. The issuer refuses to
 * treat a scope it minted preview clients for as a parent, while the registration's row
 * carries the same platform marker an app's does; clearing first means that row never
 * outlives the clients that make the issuer read the scope as a preview.
 *
 * One row per endpoint, and the issuer moves it to whichever key delivered it last. A fresh
 * preview of the same tag holds the same `--<tag>` hostname under a new scope, so a push still
 * running for the reaped one could move that preview's row onto its own key, and its removal
 * would then delete it. A push therefore registers only the hostnames the directory says its
 * preview holds now, and after its removal hands back any such row to the preview of the same
 * app that holds the hostname (`handBack`).
 */

/** The capability a vertical declares to be a team issuer (manifest `provides`, #427). */
const OIDC_ISSUER = 'oidc-issuer';
/** Rows pushed before `provides` existed — the same legacy slug the dashboard counts. */
const LEGACY_ISSUER_SLUG = 'auth-server';
/** The most callbacks a parent's hostnames yield in one check (the wire bound). */
const MAX_PARENT_CALLBACKS = 32;
const MAX_ATTEMPTS = 3;

export interface PreviewAuthDeps {
  admin: Pick<HostAdmin, 'listScopes' | 'listVerticals' | 'listHostnames' | 'getScopeRecord' | 'archiveScope' | 'resolveHostname'>;
  actor: PlatformActorId;
  /** The deployment serving an ISSUER scope — where its `/internal/preview-client` and `/internal/configure` live. */
  issuerClient(scope: Scope): Promise<VerticalClient | undefined>;
  /** Re-run an issuer call that failed transiently, as a delivery to the preview is. Default: once. */
  retry?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** The statuses `archiveScope` leaves; anything else is gone already, or past archived. */
const ARCHIVABLE: ReadonlySet<string> = new Set(['provisioning', 'active', 'suspended']);

/** The team's own auth-servers: active, not a fork, not a preview, of a vertical that provides `oidc-issuer`. */
export async function tenantIssuers(deps: PreviewAuthDeps, tenantId: TenantId): Promise<Scope[]> {
  const verticals = await deps.admin.listVerticals(deps.actor);
  const issuerSlugs = new Set([LEGACY_ISSUER_SLUG, ...verticals.filter((v) => v.provides?.includes(OIDC_ISSUER)).map((v) => v.slug)]);
  const scopes = await deps.admin.listScopes(deps.actor, { tenantId, status: ['active'] });
  return scopes.filter(
    (s) => s.tenantId === tenantId && s.vertical !== null && issuerSlugs.has(s.vertical) && !s.forkedFrom && s.kind !== 'preview',
  );
}

/** The hostname an issuer is addressed by: its canonical app hostname, else any live one. */
function issuerHostname(bound: readonly HostnameBinding[]): string | undefined {
  const live = bound.filter((h) => h.status !== 'failed');
  const active = live.filter((h) => h.status === 'active');
  const pick = (hs: readonly HostnameBinding[]) =>
    hs.find((h) => h.surface === 'app' && h.canonical) ?? hs.find((h) => h.canonical) ?? hs[0];
  return (pick(active) ?? pick(live))?.hostname;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The issuer's registration of a preview's MCP endpoints (#1619's entry): `[]` clears them. */
function previewResourcesEntry(previewScopeId: ScopeId, resources: readonly string[]): { key: string; value: string } {
  return { key: `${MCP_RESOURCES_CONFIG_PREFIX}${previewScopeId}`, value: resources.length > 0 ? JSON.stringify(resources) : '' };
}

/** Re-exported for the preview routes, which name a preview's callback on every row. */
export { oidcCallbackUrl };

export interface WirePreviewAuthInput {
  tenantId: TenantId;
  /** The version THIS push bound — the only one whose store this push may deliver to. */
  versionId: string;
  previewId: ScopeId;
  tag: string;
  /** The scope the preview forks. `null` for a clean room, which has no login to take after. */
  parent: Scope | null;
  /** The preview's `--<tag>` hostname — its callback's host. */
  previewHostname: string;
  appName: string;
  /** Deliver config into THIS push's own version deployment (never "whatever is bound now"). */
  deliver(entries: Array<{ key: string; value: string }>): Promise<void>;
}

/** Why a push left the login alone, as `preview create` reports it. */
function superseded(callbackUrl: string, why: string): PreviewAuth {
  return {
    status: 'superseded',
    callbackUrl,
    note: `Sign-in: ${why} — a newer push owns this preview's login, so this push delivered none.`,
  };
}

/**
 * Give a freshly bound preview its own client at the team auth-server its parent signs in
 * with. Answers what it did; THROWS only when it minted a client and could not leave the
 * preview with a working login — that is a failure, and `preview create` must not report it
 * as success. The secret travels from the mint's answer into `deliver` and nowhere else.
 */
export async function wirePreviewAuth(deps: PreviewAuthDeps, input: WirePreviewAuthInput): Promise<PreviewAuth> {
  const callbackUrl = oidcCallbackUrl(input.previewHostname);
  if (!input.parent) {
    return {
      status: 'not-applicable',
      callbackUrl,
      note: 'Sign-in: a clean-room preview forks no app, so it has no login to take after and none was delivered.',
    };
  }
  const parent = input.parent;
  const parentRedirectUris = [
    ...new Set(
      (await deps.admin.listHostnames(deps.actor, { scopeId: parent.id }))
        .filter((h) => h.status !== 'failed')
        .map((h) => oidcCallbackUrl(h.hostname)),
    ),
  ].slice(0, MAX_PARENT_CALLBACKS);
  const unregistered = (extra?: string): PreviewAuth => ({
    status: 'unregistered',
    callbackUrl,
    note:
      `Sign-in: no team auth server of this team signs in the app this preview forks, so no client was minted ` +
      `for it and no login config was delivered.${extra ? ` ${extra}` : ''} If the app signs in at an EXTERNAL ` +
      `issuer, that issuer needs ${callbackUrl} registered as a redirect URI — and the preview still has no ` +
      `login config, because an external client's credentials are never copied to a preview. If the app signs ` +
      `in at one of your auth servers, open the dashboard's Apps list once (it registers existing installs ` +
      `there) and re-run.`,
  });
  if (parentRedirectUris.length === 0) return unregistered('The app it forks has no hostname to sign in at.');

  // Ask every issuer of the tenant; mint only where exactly one claims.
  const claims: Array<{ scope: Scope; client: VerticalClient; hostname: string }> = [];
  const problems: Array<{ issuerScopeId: ScopeId; problem: string }> = [];
  for (const scope of await tenantIssuers(deps, input.tenantId)) {
    const client = await deps.issuerClient(scope);
    if (!client) {
      problems.push({ issuerScopeId: scope.id, problem: 'its deployment could not be resolved' });
      continue;
    }
    try {
      const { claimed } = await client.checkPreviewClient({
        tenantId: input.tenantId,
        scopeId: scope.id,
        parentScopeId: parent.id,
        parentRedirectUris,
      });
      if (!claimed) continue;
      const hostname = issuerHostname(await deps.admin.listHostnames(deps.actor, { scopeId: scope.id }));
      if (!hostname) {
        problems.push({ issuerScopeId: scope.id, problem: 'it claims the app but has no hostname to be an issuer at' });
        continue;
      }
      claims.push({ scope, client, hostname });
    } catch (e) {
      problems.push({ issuerScopeId: scope.id, problem: reasonOf(e) });
    }
  }
  if (claims.length > 1) {
    return {
      status: 'ambiguous',
      callbackUrl,
      issuers: claims.map((c) => ({ issuerScopeId: c.scope.id })),
      note:
        `Sign-in: more than one of your auth servers claims the app this preview forks ` +
        `(${claims.map((c) => c.scope.id).join(', ')}), so the platform wired none rather than guess. ` +
        `Open the dashboard's Apps list once so each auth server learns which apps are its own, then re-run.`,
    };
  }
  const claim = claims[0];
  if (!claim) {
    if (problems.length === 0) return unregistered();
    return {
      status: 'unknown',
      callbackUrl,
      issuers: problems,
      note:
        `Sign-in: not set up — ${problems.length === 1 ? 'an auth server' : 'some auth servers'} of this team ` +
        `could not be asked: ${problems.map((p) => `${p.issuerScopeId}: ${p.problem}`).join('; ')}. None that could ` +
        `be asked signs the app in. Fix that and re-run to give this preview its login.`,
    };
  }

  const issuer = `https://${claim.hostname}`;
  const address = { tenantId: input.tenantId, scopeId: claim.scope.id, previewScopeId: input.previewId };
  const retireOwn = (minted: MintedPreviewClient) =>
    claim.client.retirePreviewClients({ ...address, only: minted.clientId }).then(
      () => null,
      (e: unknown) => reasonOf(e),
    );
  /** Deliver a scope's whole set of MCP endpoints, under that scope's own key, at this issuer. */
  const registerMcp = (scopeId: ScopeId, hosts: readonly string[]) =>
    (deps.retry ?? ((fn) => fn()))(() =>
      claim.client.configureInstance({
        tenantId: input.tenantId,
        scopeId: claim.scope.id,
        entries: [previewResourcesEntry(scopeId, hosts.map((h) => mcpResourceOf(`https://${h}`)))],
      }),
    );
  /**
   * The hostnames a scope's endpoints are, by the dashboard's rule (`mcpResourcesFor`): every
   * one the directory says it actively answers on NOW. Never one it no longer holds: the issuer
   * moves a row to whichever key delivered it last, so a push still running for a reaped
   * preview must not claim the `--<tag>` hostname a newer preview of the same tag holds.
   */
  const activeHosts = async (scopeId: ScopeId): Promise<string[]> =>
    [
      ...new Set(
        (await deps.admin.listHostnames(deps.actor, { scopeId }))
          .filter((h) => h.status === 'active')
          .map((h) => h.hostname),
      ),
    ].sort();
  /** Anything but `active` is gone: the reap archives a preview before its issuer step. */
  const bound = async (): Promise<'ours' | 'moved' | 'gone'> => {
    const rec = await deps.admin.getScopeRecord(deps.actor, input.tenantId, input.previewId);
    if (!rec || rec.status !== 'active') return 'gone';
    return rec.verticalVersionId === input.versionId ? 'ours' : 'moved';
  };
  /** Set once this push has minted: from then on it may have left something at the issuer. */
  let wrote = false;
  /** What this push last asked the issuer to register — the rows its delivery may have moved. */
  let registeredHosts: string[] = [];
  /** Is this scope an active preview of the same app — one a hand-back may write for? */
  const liveSibling = async (scopeId: ScopeId): Promise<boolean> => {
    const rec = await deps.admin.getScopeRecord(deps.actor, input.tenantId, scopeId);
    return rec?.status === 'active' && rec.kind === 'preview' && rec.forkedFrom === parent.id;
  };
  /**
   * After this push cleared its own key: hand back a row it moved off a NEWER preview of the
   * same app (the same `--<tag>` hostname under a fresh scope), which the clear just deleted.
   * The directory names who holds each hostname now; that preview gets its own whole set back
   * under its own key, as its own push sends it. Anything else holding one is left alone.
   *
   * The hand-back is an issuer write like any other, so it is followed by a look: a holder
   * reaped while it was in flight has its key cleared again. Its reap archives it before its
   * own clear, so either this look sees the archive or that clear lands after this write.
   */
  const handBack = async (): Promise<void> => {
    const holders = new Set<ScopeId>();
    for (const hostname of registeredHosts) {
      const route = await deps.admin.resolveHostname(hostname);
      if (route && route.tenantId === input.tenantId && route.scopeId !== input.previewId) holders.add(route.scopeId);
    }
    for (const holder of holders) {
      if (!(await liveSibling(holder))) continue;
      await registerMcp(holder, await activeHosts(holder));
      if (!(await liveSibling(holder))) await registerMcp(holder, []);
    }
  };
  const reapedMeanwhile = async (): Promise<PreviewAuth> => {
    // The preview was reaped while this push ran. What this push wrote after the reap's issuer
    // step is this push's to remove (see "A reap racing a push"), and a step that fails is
    // said, each in its own words: after the row is gone, nothing names those writes again.
    // Every step runs whatever the others did, except that the clients stay when the clear
    // failed, so the registration never outlives them (clear first, as the reap does).
    if (wrote) {
      const failed: string[] = [];
      const step = (what: string, run: () => Promise<unknown>) =>
        run().then(
          () => true,
          (e: unknown) => {
            failed.push(`${what} failed (${reasonOf(e)})`);
            return false;
          },
        );
      const cleared = await step("clearing this preview's MCP registration", () => registerMcp(input.previewId, []));
      await step('handing back the MCP registration of the newer preview that holds its hostname', handBack);
      if (cleared) await step("deleting this push's client", () => claim.client.retirePreviewClients(address));
      else failed.push("its client was kept, so it does not outlive the registration that failed to clear");
      if (failed.length > 0) {
        throw new ControlPlaneError(
          502,
          `preview '${input.tag}' was reaped while this push ran, and at the auth server ${claim.scope.id} ` +
            `${failed.join('; ')}.`,
        );
      }
    }
    return superseded(callbackUrl, 'the preview was reaped while this push ran');
  };
  const noLogin = (why: string): ControlPlaneError =>
    new ControlPlaneError(
      502,
      `preview '${input.tag}' was created but has NO working login: ${why}. Re-run \`preview create\` to retry.`,
    );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const before = await bound();
    if (before === 'gone') return reapedMeanwhile();
    if (before === 'moved') return superseded(callbackUrl, 'another push re-bound the preview');

    let minted: MintedPreviewClient;
    try {
      minted = await claim.client.mintPreviewClient({
        ...address,
        parentScopeId: parent.id,
        parentRedirectUris,
        redirectUri: callbackUrl,
        postLogoutRedirectUri: `https://${input.previewHostname}/`,
        clientName: `${input.appName} (preview ${input.tag})`,
      });
    } catch (e) {
      throw noLogin(`the auth server ${claim.scope.id} did not mint its client (${reasonOf(e)})`);
    }
    wrote = true;

    try {
      await input.deliver([
        {
          key: 'substrat:auth',
          value: JSON.stringify({ mode: 'oidc', issuer, clientId: minted.clientId, clientSecret: minted.clientSecret }),
        },
        // A team auth-server is shared by construction (#1683): the preview accepts its OWN tokens only.
        { key: SHARED_ISSUER_CONFIG_KEY, value: 'true' },
      ]);
    } catch (e) {
      const cleanup = await retireOwn(minted);
      throw noLogin(
        `delivering its client failed (${reasonOf(e)})` +
          (cleanup ? `, and removing that client failed too (${cleanup}) — the preview's reap removes it` : ''),
      );
    }

    const after = await bound();
    if (after === 'gone') return reapedMeanwhile(); // which removes our client with the rest
    if (after === 'moved') {
      // Our client sits only in our own version's store, which is no longer served.
      await retireOwn(minted);
      return superseded(callbackUrl, 'another push re-bound the preview');
    }

    // Delivered and bound: the issuer signs this preview in now, so it may mint for the
    // preview's MCP endpoints too. A repeat (a retry below, every later push) writes nothing.
    const mcp = await activeHosts(input.previewId)
      .then(async (hosts) => {
        registeredHosts = hosts;
        await registerMcp(input.previewId, hosts);
        return hosts.length > 0
          ? ` MCP: ${hosts.map((h) => mcpResourceOf(`https://${h}`)).join(', ')} registered there too, and un-registered by the same reap.`
          : ` MCP: the preview answers on no active hostname yet, so no endpoint of it is registered there.`;
      })
      .catch(
        (e: unknown) =>
          ` MCP: the preview's endpoint could not be registered there (${reasonOf(e)}), so an MCP client ` +
          `pointed at the preview gets invalid_target until the next push registers it.`,
      );

    let older = '';
    try {
      const retired = await claim.client.retirePreviewClients({ ...address, keep: minted.clientId });
      if (retired.kept === false) continue; // our own client vanished while our version is bound
    } catch (e) {
      // Delivered and bound: the login works. What is left is older clients, which the next
      // push or the reap removes — said, not hidden.
      older = ` Older clients of this preview could not be removed yet (${reasonOf(e)}); the next push or the reap removes them.`;
    }
    // The look after this push's last issuer write, on every way to `wired` (see "A reap racing a push").
    if ((await bound()) === 'gone') return reapedMeanwhile();
    return wired(claim.scope.id, issuer, minted.clientId, callbackUrl, `${mcp}${older}`);
  }
  // The last attempt's `continue` lands here, after its writes: the same look, before giving up,
  // and the same answers the loop gives.
  const last = await bound();
  if (last === 'gone') return reapedMeanwhile();
  if (last === 'moved') return superseded(callbackUrl, 'another push re-bound the preview');
  throw noLogin(`its client kept disappearing at the auth server ${claim.scope.id} (${MAX_ATTEMPTS} attempts)`);
}

function wired(issuerScopeId: ScopeId, issuer: string, clientId: string, callbackUrl: string, extra: string): PreviewAuth {
  return {
    status: 'wired',
    callbackUrl,
    issuer,
    issuerScopeId,
    clientId,
    note: `Sign-in: this preview has its own client at your auth server ${issuer} (client ${clientId}); it is deleted when the preview is reaped.${extra}`,
  };
}

/** A refusal that says the deployment does not implement the call: it cannot hold what the call removes. */
const predates = (e: unknown): boolean => e instanceof ControlPlaneError && e.status === 501;

/**
 * Un-register a preview's MCP endpoint and delete every client minted for it, at every
 * auth-server of its tenant, in that order (see "A reap racing a push") — the reap's half,
 * run BEFORE the preview's storage and row go, so a failure leaves a preview a retry can still
 * find. A deployment that takes no delivery holds no registration, and one that predates
 * preview clients holds no client; each is skipped for that half. Any other failure throws.
 */
export async function retireAllPreviewClients(
  deps: PreviewAuthDeps,
  tenantId: TenantId,
  previewScopeId: ScopeId,
): Promise<string[]> {
  const deleted: string[] = [];
  for (const scope of await tenantIssuers(deps, tenantId)) {
    const client = await deps.issuerClient(scope);
    if (!client) throw new ControlPlaneError(502, `the auth server ${scope.id} could not be reached to delete preview ${previewScopeId}'s clients`);
    await client
      .configureInstance({ tenantId, scopeId: scope.id, entries: [previewResourcesEntry(previewScopeId, [])] })
      .catch((e: unknown) => {
        if (!predates(e)) throw e;
      });
    try {
      deleted.push(...(await client.retirePreviewClients({ tenantId, scopeId: scope.id, previewScopeId })).deleted);
    } catch (e) {
      if (!predates(e)) throw e;
    }
  }
  return deleted;
}

/**
 * The reap's half for ANY scope about to go, as the platform sweep's expiry GC sees it: a
 * preview fork is archived — so no push still running can wire it again — and then its MCP
 * registration is cleared and its clients retired; anything else — a snapshot, a clean room —
 * has neither and is left alone. One predicate for the interactive reap and the sweep, so
 * they agree. A reap that fails after the archive leaves an archived preview, which the reap's
 * retry (the DELETE, the sweep's next pass, a create of the same tag) finds and finishes.
 */
export async function retireClientsOfReapedScope(deps: PreviewAuthDeps, scope: Scope | undefined): Promise<string[]> {
  if (!scope || scope.kind !== 'preview' || !scope.forkedFrom) return [];
  await archiveForReap(deps, scope);
  return retireAllPreviewClients(deps, scope.tenantId, scope.id);
}

/** Archive a preview about to be reaped, unless it is archived (or gone) already — by a reap racing this one, too. */
async function archiveForReap(deps: PreviewAuthDeps, scope: Scope): Promise<void> {
  const current = async () => (await deps.admin.getScopeRecord(deps.actor, scope.tenantId, scope.id))?.status;
  const status = await current();
  if (status === undefined || !ARCHIVABLE.has(status)) return;
  await deps.admin.archiveScope(deps.actor, scope.tenantId, scope.id).catch(async (e: unknown) => {
    const now = await current();
    if (now !== undefined && ARCHIVABLE.has(now)) throw e;
  });
}
