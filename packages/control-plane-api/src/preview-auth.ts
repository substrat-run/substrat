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
 */

/** The capability a vertical declares to be a team issuer (manifest `provides`, #427). */
const OIDC_ISSUER = 'oidc-issuer';
/** Rows pushed before `provides` existed — the same legacy slug the dashboard counts. */
const LEGACY_ISSUER_SLUG = 'auth-server';
/** The most callbacks a parent's hostnames yield in one check (the wire bound). */
const MAX_PARENT_CALLBACKS = 32;
const MAX_ATTEMPTS = 3;

export interface PreviewAuthDeps {
  admin: Pick<HostAdmin, 'listScopes' | 'listVerticals' | 'listHostnames' | 'getScopeRecord'>;
  actor: PlatformActorId;
  /** The deployment serving an ISSUER scope — where its `/internal/preview-client` and `/internal/configure` live. */
  issuerClient(scope: Scope): Promise<VerticalClient | undefined>;
}

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
  const registerMcp = (resources: readonly string[]) =>
    claim.client.configureInstance({
      tenantId: input.tenantId,
      scopeId: claim.scope.id,
      entries: [previewResourcesEntry(input.previewId, resources)],
    });
  const bound = async (): Promise<'ours' | 'moved' | 'gone'> => {
    const rec = await deps.admin.getScopeRecord(deps.actor, input.tenantId, input.previewId);
    if (!rec || rec.status !== 'active') return 'gone';
    return rec.verticalVersionId === input.versionId ? 'ours' : 'moved';
  };
  const reapedMeanwhile = async (): Promise<PreviewAuth> => {
    // The preview was reaped while this push ran: nothing may outlive it at the issuer.
    await claim.client.retirePreviewClients(address).catch(() => undefined);
    await registerMcp([]).catch(() => undefined);
    return superseded(callbackUrl, 'the preview was reaped while this push ran');
  };
  // The preview's endpoints by the dashboard's rule (`mcpResourcesFor`): one per hostname it
  // actively answers on — and always the one its login is wired for. The delivery is the whole
  // set, so a hostname left out here would be un-registered.
  const mcpResources = async (): Promise<string[]> => {
    const live = (await deps.admin.listHostnames(deps.actor, { scopeId: input.previewId }))
      .filter((h) => h.status === 'active')
      .map((h) => h.hostname);
    return [...new Set([input.previewHostname, ...live].map((h) => mcpResourceOf(`https://${h}`)))].sort();
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
    if (after !== 'ours') {
      // Our client sits only in our own version's store, which is no longer served.
      await retireOwn(minted);
      return after === 'gone' ? reapedMeanwhile() : superseded(callbackUrl, 'another push re-bound the preview');
    }

    // Delivered and bound: the issuer signs this preview in now, so it may mint for the
    // preview's MCP endpoints too. A repeat (a retry below, every later push) writes nothing.
    const mcp = await mcpResources()
      .then(async (resources) => {
        await registerMcp(resources);
        return ` MCP: ${resources.join(', ')} registered there too, and un-registered by the same reap.`;
      })
      .catch(
        (e: unknown) =>
          ` MCP: the preview's endpoint could not be registered there (${reasonOf(e)}), so an MCP client ` +
          `pointed at the preview gets invalid_target until the next push registers it.`,
      );

    let retired;
    try {
      retired = await claim.client.retirePreviewClients({ ...address, keep: minted.clientId });
    } catch (e) {
      // Delivered and bound: the login works. What is left is older clients, which the next
      // push or the reap removes — said, not hidden.
      return wired(claim.scope.id, issuer, minted.clientId, callbackUrl, `${mcp} Older clients of this preview could not be removed yet (${reasonOf(e)}); the next push or the reap removes them.`);
    }
    if (retired.kept === false) continue; // our own client vanished while our version is bound
    if ((await bound()) === 'gone') return reapedMeanwhile();
    return wired(claim.scope.id, issuer, minted.clientId, callbackUrl, mcp);
  }
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

/**
 * Delete every client minted for a preview, and un-register its MCP endpoint, at every
 * auth-server of its tenant — the reap's half, run BEFORE the preview's storage and row go,
 * so a failure leaves a preview a retry can still find. An auth-server that predates preview
 * clients cannot have minted one, nor registered an endpoint for it (that follows a mint),
 * and is skipped; any other failure throws.
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
    try {
      deleted.push(...(await client.retirePreviewClients({ tenantId, scopeId: scope.id, previewScopeId })).deleted);
    } catch (e) {
      if (e instanceof ControlPlaneError && e.status === 501) continue;
      throw e;
    }
    await client.configureInstance({ tenantId, scopeId: scope.id, entries: [previewResourcesEntry(previewScopeId, [])] });
  }
  return deleted;
}

/**
 * The reap's half for ANY scope about to go, as the platform sweep's expiry GC sees it: a
 * preview fork's clients are retired and its MCP registration cleared, and anything else — a
 * snapshot, a clean room — has neither and is left alone. One predicate for the interactive
 * reap and the sweep, so they agree.
 */
export async function retireClientsOfReapedScope(deps: PreviewAuthDeps, scope: Scope | undefined): Promise<string[]> {
  if (!scope || scope.kind !== 'preview' || !scope.forkedFrom) return [];
  return retireAllPreviewClients(deps, scope.tenantId, scope.id);
}
