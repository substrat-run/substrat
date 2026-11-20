import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  PLATFORM_SECRET_HEADER,
  SOCIAL_RELAY_CONFIG_KEY,
  SOCIAL_RELAY_DELIVERY_STALE,
  SOCIAL_RELAY_SECRET_NEEDED,
  SOCIAL_RELAY_SECRET_STALE,
  platformActorId,
  scopeId,
  socialRelayDelivery,
  tenantId,
  type HostnameBinding,
  type PlatformActorId,
  type SocialRelayDelivery,
} from '@substrat-run/contracts';
import {
  ControlPlaneError,
  DELIVERY_SUPERSEDED,
  DEV_ACTOR_HEADER,
  ROTATED_MEANWHILE,
  ROTATION_IN_PROGRESS,
  UNSAFE_devPlatformActorAuth,
  createControlPlaneApi,
  isSocialRelayVertical,
  reconcilePendingHostnames,
  reconcileSocialRelay,
  relayHostnames,
  relayRedirectUris,
  selfReconcileSocialRelay,
  SELF_ROTATION_REFUSED,
  type SocialRelayOptions,
  type VerticalClient,
} from '../src/index.js';

/**
 * Platform-provided social sign-in (#1544), the control plane's half: keeping one Auth Server
 * install's client at the platform's social relay in step with the relay's providers and the
 * install's hostnames, and delivering it.
 *
 * The relay here is a fake that keeps the real one's rules — a client per ref, its secret handed
 * out only at creation, a rotation that is a compare-and-set on the secret's generation under a
 * lease (#3275), the platform header required — and the install is a fake that keeps the issuer's:
 * it holds the secret it was given with its generation, answers 409 `SOCIAL_RELAY_SECRET_NEEDED`
 * when a delivery carries none and it holds none, `SOCIAL_RELAY_SECRET_STALE` when the relay is
 * past the one it holds, and `SOCIAL_RELAY_DELIVERY_STALE` to a secret older than its own. Both
 * real halves are held to those rules in their own suites (`apps/social-relay`,
 * `demos/auth-server`); this one is about the reconcile that runs between them.
 */

const ORIGIN = 'https://id.substrat.net';
const SECRET = 'platform-secret';

function provider(id: string, label: string) {
  const issuer = `${ORIGIN}/${id}`;
  return {
    id,
    label,
    issuer,
    endpoints: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
    },
  };
}

interface FakeClient {
  clientId: string;
  secret: string;
  generation: number;
  name: string;
  redirectUris: string[];
  disabled: boolean;
}

interface FakeRelay {
  options: SocialRelayOptions;
  providers: ReturnType<typeof provider>[];
  clients: Map<string, FakeClient>;
  /** The live rotation lease per client id. */
  leases: Map<string, string>;
  calls: string[];
  failNext?: number;
  /** A relay from before generations: no generation, no lease, a rotation that compares nothing. */
  legacy?: boolean;
  /** Serialization bypassed (#3275's last line of defence): no lease and no compare-and-set. */
  unserialized?: boolean;
  /** How many secrets were handed out by rotation. */
  rotations: number;
  /** Hold the next rotation request on its way in, as a slow network would. */
  holdRotation(): { arrived: Promise<void>; release(): void };
}

function fakeRelay(): FakeRelay {
  const relay: FakeRelay = {
    providers: [provider('github', 'GitHub')],
    clients: new Map(),
    leases: new Map(),
    calls: [],
    rotations: 0,
    options: undefined as never,
    holdRotation() {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((r) => (reached = r));
      held = { reached: () => reached(), release: new Promise<void>((r) => (release = r)) };
      return { arrived, release: () => release() };
    },
  };
  let held: { reached(): void; release: Promise<void> } | undefined;
  let n = 0;
  const lease = (clientId: string) => {
    if (relay.legacy || relay.unserialized) return {};
    const id = `lease-${++n}`;
    relay.leases.set(clientId, id);
    return { lease: id };
  };
  const generation = (c: FakeClient) => (relay.legacy ? {} : { generation: c.generation });
  relay.options = {
    origin: ORIGIN,
    platformSecret: SECRET,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      relay.calls.push(`${method} ${url.pathname}`);
      if (relay.failNext) {
        const status = relay.failNext;
        relay.failNext = undefined;
        return new Response(JSON.stringify({ error: 'boom' }), { status });
      }
      if (url.pathname === '/providers') return Response.json({ providers: relay.providers });
      const headers = new Headers(init?.headers);
      if (headers.get(PLATFORM_SECRET_HEADER) !== SECRET) return Response.json({ error: 'forbidden' }, { status: 403 });
      const byId = (id: string) => [...relay.clients.values()].find((c) => c.clientId === id);
      const byRef = url.pathname.match(/^\/internal\/clients\/by-ref\/(.+)$/);
      if (byRef && method === 'PUT') {
        const ref = decodeURIComponent(byRef[1]!);
        const body = JSON.parse(String(init?.body)) as { name: string; redirectUris: string[] };
        const existing = relay.clients.get(ref);
        if (existing) {
          Object.assign(existing, body);
          return Response.json({ clientId: existing.clientId, clientSecret: null, created: false, disabled: existing.disabled, ...generation(existing) });
        }
        const created = { clientId: `client-${++n}`, secret: `secret-${n}`, generation: 1, disabled: false, ...body };
        relay.clients.set(ref, created);
        return Response.json(
          { clientId: created.clientId, clientSecret: created.secret, created: true, disabled: false, ...generation(created), ...lease(created.clientId) },
          { status: 201 },
        );
      }
      const rotate = url.pathname.match(/^\/internal\/clients\/([^/]+)\/secret$/);
      if (rotate && method === 'POST') {
        if (held) {
          const h = held;
          held = undefined;
          h.reached();
          await h.release;
        }
        const client = byId(rotate[1]!);
        const body = JSON.parse(String(init?.body ?? '{}')) as { generation?: number };
        if (!relay.legacy && !Number.isInteger(body.generation)) return Response.json({ detail: 'generation is required' }, { status: 400 });
        if (!client) return Response.json({ error: 'no such client' }, { status: 404 });
        if (!relay.legacy && !relay.unserialized) {
          if (relay.leases.has(client.clientId)) return Response.json({ code: 'conflict' }, { status: 409 });
          if (body.generation !== client.generation) return Response.json({ code: 'precondition_failed' }, { status: 412 });
        }
        client.secret = `rotated-${++n}`;
        client.generation += 1;
        relay.rotations += 1;
        return Response.json({ clientSecret: client.secret, ...generation(client), ...lease(client.clientId) });
      }
      const release = url.pathname.match(/^\/internal\/clients\/([^/]+)\/rotation-lease\/([^/]+)$/);
      if (release && method === 'DELETE') {
        const released = relay.leases.get(release[1]!) === release[2];
        if (released) relay.leases.delete(release[1]!);
        return Response.json({ released });
      }
      return Response.json({ error: 'not implemented' }, { status: 501 });
    },
  };
  return relay;
}

/** The relay's current secret for the one install these tests reconcile. */
const live = (relay: FakeRelay) => relay.clients.get('scope:s1')!;

/** An install that behaves like the issuer: it keeps the secret it was given, and its generation. */
function fakeInstall() {
  const holds: Array<{ match: (d: SocialRelayDelivery) => boolean; reached: () => void; release: Promise<void> }> = [];
  const install = {
    held: null as { clientId: string; secret: string; generation?: number } | null,
    deliveries: [] as SocialRelayDelivery[],
    /**
     * Hold the next delivery `match` picks in flight, as a slow dispatch would: `reached` resolves
     * once it has arrived, and it is applied only when `release` is called.
     */
    hold(match: (d: SocialRelayDelivery) => boolean) {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((r) => (reached = r));
      holds.push({ match, reached: () => reached(), release: new Promise<void>((r) => (release = r)) });
      return { arrived, release: () => release() };
    },
    configure: async (entries: { key: string; value: string }[]) => {
      for (const entry of entries) {
        if (entry.key !== SOCIAL_RELAY_CONFIG_KEY) continue;
        const delivery = socialRelayDelivery.parse(JSON.parse(entry.value));
        const held = holds.findIndex((h) => h.match(delivery));
        if (held >= 0) {
          const [h] = holds.splice(held, 1);
          h!.reached();
          await h!.release;
        }
        install.deliveries.push(delivery);
        const same = install.held?.clientId === delivery.clientId ? install.held : null;
        const g = delivery.generation;
        if (delivery.clientSecret) {
          if (same?.generation !== undefined && g !== undefined && g < same.generation) {
            throw new ControlPlaneError(409, SOCIAL_RELAY_DELIVERY_STALE);
          }
          install.held = { clientId: delivery.clientId, secret: delivery.clientSecret, ...(g === undefined ? {} : { generation: g }) };
          continue;
        }
        if (!same) throw new ControlPlaneError(409, SOCIAL_RELAY_SECRET_NEEDED);
        if (g !== undefined && same.generation === undefined) throw new ControlPlaneError(409, SOCIAL_RELAY_SECRET_NEEDED);
        if (g !== undefined && same.generation! < g) throw new ControlPlaneError(409, SOCIAL_RELAY_SECRET_STALE);
      }
    },
  };
  return install;
}

/** Is the install's secret one the relay accepts — the only thing sign-in through the relay needs. */
const signsIn = (relay: FakeRelay, install: ReturnType<typeof fakeInstall>) => install.held?.secret === live(relay).secret;

describe('reconciling one install', () => {
  let relay: FakeRelay;
  let install: ReturnType<typeof fakeInstall>;
  const run = (hostnames: string[]) =>
    reconcileSocialRelay(relay.options, { tenantId: 't', scopeId: 's1', hostnames, configure: install.configure });

  beforeEach(() => {
    relay = fakeRelay();
    install = fakeInstall();
  });

  it('creates the client once, delivering its secret, and the install then holds the relay’s', async () => {
    const outcome = await run(['acme.global.substrat.run']);
    expect(outcome).toEqual({
      status: 'delivered',
      clientId: 'client-1',
      created: true,
      rotated: false,
      disabled: false,
      providers: ['github'],
      hostnames: ['acme.global.substrat.run'],
    });
    expect(relay.clients.get('scope:s1')).toMatchObject({
      name: 't/s1',
      redirectUris: ['https://acme.global.substrat.run/api/auth/callback/github-relay'],
    });
    expect(install.held).toEqual({ clientId: 'client-1', secret: live(relay).secret, generation: 1 });
    expect(relay.leases.size).toBe(0);
  });

  it('on a later run replaces the redirect URIs and delivers no secret, so the held one stays', async () => {
    await run(['acme.global.substrat.run']);
    const secret = install.held!.secret;
    relay.providers.push(provider('google', 'Google'));
    const outcome = await run(['acme.global.substrat.run', 'Login.Acme.example']);
    expect(outcome).toMatchObject({ status: 'delivered', created: false, rotated: false, providers: ['github', 'google'] });
    expect(install.deliveries.at(-1)?.clientSecret).toBeUndefined();
    expect(install.held!.secret).toBe(secret);
    expect(relay.clients.get('scope:s1')?.redirectUris).toEqual([
      'https://acme.global.substrat.run/api/auth/callback/github-relay',
      'https://acme.global.substrat.run/api/auth/callback/google-relay',
      'https://login.acme.example/api/auth/callback/github-relay',
      'https://login.acme.example/api/auth/callback/google-relay',
    ]);
    expect(relay.calls.filter((c) => c.endsWith('/secret'))).toEqual([]);
  });

  it('rotates and delivers again only when the install holds no secret', async () => {
    await run(['acme.global.substrat.run']);
    install.held = null; // the install lost it (or the first delivery never landed)
    const outcome = await run(['acme.global.substrat.run']);
    expect(outcome).toMatchObject({ status: 'delivered', created: false, rotated: true });
    expect(install.held).toEqual({ clientId: 'client-1', secret: live(relay).secret, generation: 2 });
    expect(relay.leases.size).toBe(0);
    expect(relay.clients.get('scope:s1')!.secret).toMatch(/^rotated-/);
  });

  it('passes any other delivery failure through untouched, without rotating', async () => {
    const failing = async () => {
      throw new ControlPlaneError(503, 'the install is down');
    };
    await expect(
      reconcileSocialRelay(relay.options, { tenantId: 't', scopeId: 's1', hostnames: ['a.example'], configure: failing }),
    ).rejects.toThrow('the install is down');
    expect(relay.calls.filter((c) => c.endsWith('/secret'))).toEqual([]);
  });

  it('skips, registering nothing, when there is no provider or no hostname', async () => {
    expect(await run([])).toEqual({ status: 'skipped', reason: 'the install has no active hostname' });
    relay.providers = [];
    expect(await run(['a.example'])).toEqual({ status: 'skipped', reason: 'the relay serves no provider' });
    expect(relay.clients.size).toBe(0);
    expect(install.deliveries).toEqual([]);
  });

  it('says which call the relay refused', async () => {
    relay.failNext = 500;
    await expect(run(['a.example'])).rejects.toThrow(/social relay refused GET \/providers \(500\)/);
  });
});

/**
 * The interleavings of #3275, each replayed exactly: one run's delivery is held in flight while an
 * overlapping run of the same install goes all the way through, then let go.
 */
describe('overlapping reconciles of one install (#3275)', () => {
  let relay: FakeRelay;
  let install: ReturnType<typeof fakeInstall>;
  const run = (opts: { rotate?: boolean } = {}) =>
    reconcileSocialRelay(relay.options, { tenantId: 't', scopeId: 's1', hostnames: ['a.example'], configure: install.configure, ...opts });
  const carriesSecret = (d: SocialRelayDelivery) => d.clientSecret !== undefined;

  /** A registered install that has lost its secret — what both runs of the double rotation find. */
  const registeredWithoutSecret = async () => {
    await run();
    install.held = null;
  };

  beforeEach(() => {
    relay = fakeRelay();
    install = fakeInstall();
  });

  it('never rotates twice: while one run delivers its new secret, the overlapping run skips', async () => {
    await registeredWithoutSecret();
    const a = install.hold(carriesSecret);
    const runA = run();
    await a.arrived; // A has rotated and its delivery is in flight
    expect(await run()).toEqual({ status: 'skipped', reason: ROTATION_IN_PROGRESS });
    a.release();
    expect(await runA).toMatchObject({ status: 'delivered', rotated: true });
    expect(relay.rotations).toBe(1);
    expect(signsIn(relay, install)).toBe(true);
    expect(relay.leases.size).toBe(0);
  });

  it('never rotates the secret a creating run is still delivering', async () => {
    const a = install.hold(carriesSecret);
    const runA = run();
    await a.arrived; // A created the client; the secret handed out on creation is in flight
    expect(await run()).toEqual({ status: 'skipped', reason: ROTATION_IN_PROGRESS });
    a.release();
    expect(await runA).toMatchObject({ status: 'delivered', created: true, rotated: false });
    expect(relay.rotations).toBe(0);
    expect(signsIn(relay, install)).toBe(true);
  });

  it('rotates once from the generation both runs read, so the second is told it moved on', async () => {
    await registeredWithoutSecret();
    // B hears the install holds none and asks to rotate from generation 1; its request is slow.
    const b = relay.holdRotation();
    const runB = run();
    await b.arrived;
    // A, meanwhile, rotates from generation 1, delivers, and gives its lease back.
    expect(await run()).toMatchObject({ status: 'delivered', rotated: true });
    b.release();
    expect(await runB).toEqual({ status: 'skipped', reason: ROTATED_MEANWHILE });
    expect(relay.rotations).toBe(1);
    expect(signsIn(relay, install)).toBe(true);
  });

  it('refuses the slower, older delivery even with the lease and the compare-and-set bypassed', async () => {
    await registeredWithoutSecret();
    relay.unserialized = true;
    // A rotates and its delivery stalls; B rotates after it and delivers first.
    const a = install.hold(carriesSecret);
    const runA = run();
    await a.arrived;
    expect(await run()).toMatchObject({ status: 'delivered', rotated: true });
    a.release();
    expect(await runA).toEqual({ status: 'skipped', reason: DELIVERY_SUPERSEDED });
    expect(relay.rotations).toBe(2);
    expect(install.held).toMatchObject({ generation: 3 });
    expect(signsIn(relay, install)).toBe(true);
  });

  it('heals an install left holding a rotated-out secret, once, even on its own call', async () => {
    await run();
    // A rotation whose delivery never landed: the relay moved to generation 2, the install holds 1.
    Object.assign(live(relay), { secret: 'lost-in-flight', generation: 2 });
    expect(signsIn(relay, install)).toBe(false);
    // The install's own call says it holds a client, and its secret is provably dead: rotate it.
    expect(await run({ rotate: false })).toMatchObject({ status: 'delivered', rotated: true });
    expect(install.held).toMatchObject({ generation: 3 });
    expect(signsIn(relay, install)).toBe(true);
    // Healed, it stays healed: the next run rotates nothing.
    expect(await run({ rotate: false })).toMatchObject({ status: 'delivered', rotated: false });
    expect(relay.rotations).toBe(1);
  });

  it('gives the lease back when the new secret’s delivery fails, so the next run can rotate at once', async () => {
    await registeredWithoutSecret();
    const failing = { calls: 0 };
    const outcome = reconcileSocialRelay(relay.options, {
      tenantId: 't',
      scopeId: 's1',
      hostnames: ['a.example'],
      configure: async (entries) => {
        if (failing.calls++ === 0) return install.configure(entries);
        throw new ControlPlaneError(503, 'the install is down');
      },
    });
    await expect(outcome).rejects.toThrow('the install is down');
    expect(relay.leases.size).toBe(0);
    expect(await run()).toMatchObject({ status: 'delivered', rotated: true });
    expect(signsIn(relay, install)).toBe(true);
  });

  it('delivers as it always did through a relay older than generations', async () => {
    relay.legacy = true;
    expect(await run()).toMatchObject({ status: 'delivered', created: true });
    install.held = null;
    expect(await run()).toMatchObject({ status: 'delivered', rotated: true });
    expect(install.deliveries.every((d) => d.generation === undefined)).toBe(true);
    expect(signsIn(relay, install)).toBe(true);
  });
});

describe("the install's own call", () => {
  let relay: FakeRelay;
  let install: ReturnType<typeof fakeInstall>;
  const verticals: Record<string, string> = { s1: 'auth-server', s2: 'crm' };
  const self = (scope: string, hasClient: boolean) =>
    selfReconcileSocialRelay(
      {
        relay: relay.options,
        getScope: async (_t, s) => (verticals[s] ? { vertical: verticals[s]! } : undefined),
        activeHostnames: async () => ['acme.global.substrat.run'],
        deploymentOf: async () => ({ configureInstance: ({ entries }) => install.configure(entries) }),
      },
      { tenantId: 't', scopeId: scope, hasClient },
    );

  beforeEach(async () => {
    relay = fakeRelay();
    install = fakeInstall();
    await self('s1', false); // registered once, so the relay holds the client from here on
    install.held = null; // and the install has lost its secret
  });

  it('never rotates for an install that says it holds a client, and rotates for one that says it holds none', async () => {
    const before = relay.clients.get('scope:s1')!.secret;
    expect(await self('s1', true)).toEqual({ ok: true, outcome: { status: 'skipped', reason: SELF_ROTATION_REFUSED } });
    expect(relay.clients.get('scope:s1')!.secret).toBe(before);
    expect(relay.calls.filter((c) => c.endsWith('/secret'))).toEqual([]);

    expect(await self('s1', false)).toMatchObject({ ok: true, outcome: { status: 'delivered', rotated: true } });
    expect(install.held).toEqual({ clientId: 'client-1', secret: live(relay).secret, generation: 2 });
  });

  it('refuses a scope that is not an Auth Server install, or no scope at all, before the relay is asked', async () => {
    const calls = relay.calls.length;
    expect(await self('s2', false)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await self('s3', false)).toMatchObject({ ok: false, code: 'not_found' });
    expect(relay.calls).toHaveLength(calls);
  });
});

describe('the pieces it is built from', () => {
  it('builds one callback per provider per host, hosts lowercased, deduplicated and sorted', () => {
    expect(relayRedirectUris(['B.example', 'a.example', 'b.example'], [provider('github', 'GitHub')])).toEqual([
      'https://a.example/api/auth/callback/github-relay',
      'https://b.example/api/auth/callback/github-relay',
    ]);
  });

  it('registers a platform hostname as it is, and a custom domain only once Cloudflare says it is verified', async () => {
    const checked: string[] = [];
    const provisioner = {
      create: async () => {
        throw new Error('unused');
      },
      remove: async () => {},
      check: async (id: string) => {
        checked.push(id);
        return { customHostnameId: id, status: id === 'ch_ok' ? ('active' as const) : ('verifying' as const), note: null, records: [] };
      },
    };
    const rows = [
      { hostname: 'acme.global.substrat.run', status: 'active', customHostnameId: null },
      { hostname: 'paused.global.substrat.run', status: 'suspended', customHostnameId: null },
      // Marked active by hand, never verified — the case a tenant can produce with PATCH /status.
      { hostname: 'never-verified.example', status: 'active', customHostnameId: null },
      { hostname: 'unverified.example', status: 'active', customHostnameId: 'ch_pending' },
      { hostname: 'login.acme.example', status: 'active', customHostnameId: 'ch_ok' },
    ];
    const isCustom = (h: string) => !h.endsWith('.substrat.run');
    expect(await relayHostnames(rows, { isCustom, provisioner })).toEqual(['acme.global.substrat.run', 'login.acme.example']);
    expect(checked).toEqual(['ch_pending', 'ch_ok']);
    // No provisioner (dev, self-host): nothing can be verified, so no custom domain is registered.
    expect(await relayHostnames(rows, { isCustom })).toEqual(['acme.global.substrat.run']);
  });

  it('is for the platform’s auth-server only, never a builder’s vertical of the same name', () => {
    expect(isSocialRelayVertical('auth-server')).toBe(true);
    // The platform workspace's lineage, which the standard Auth Server's installs are bound to.
    expect(isSocialRelayVertical('substrat-9yjbbn/auth-server')).toBe(true);
    expect(isSocialRelayVertical('acme/auth-server')).toBe(false);
    expect(isSocialRelayVertical(null)).toBe(false);
  });
});

describe('the hostname sweep', () => {
  it('tells the caller about each custom domain it moved to active, and survives the callback failing', async () => {
    const actor = platformActorId.parse(ulid());
    const row = (hostname: string): HostnameBinding =>
      ({
        hostname,
        tenantId: 't',
        scopeId: 's',
        verticalSlug: 'auth-server',
        surface: 'app',
        region: null,
        status: 'verifying',
        statusNote: null,
        canonical: true,
        createdAt: '2026-10-19T00:00:00.000Z',
        customHostnameId: `ch_${hostname}`,
        validationRecords: [],
      }) as unknown as HostnameBinding;
    const told: string[] = [];
    const out = await reconcilePendingHostnames({
      admin: {
        listScopes: async () => [],
        listHostnames: async () => [row('login.acme.example'), row('still.acme.example')],
        setHostnameIssuance: async () => {},
        unbindHostname: async () => {},
      } as never,
      actor: actor as PlatformActorId,
      provisioner: {
        create: async () => {
          throw new Error('unused');
        },
        check: async (id: string) => ({
          customHostnameId: id,
          status: id === 'ch_login.acme.example' ? ('active' as const) : ('verifying' as const),
          note: null,
          records: [],
        }),
        remove: async () => {},
      },
      isCustom: () => true,
      onActivated: async (h) => {
        told.push(h.hostname);
        throw new Error('the relay is down');
      },
    });
    expect(told).toEqual(['login.acme.example']);
    expect(out.activated).toBe(1);
    expect(out.errors).toEqual([]);
  });
});

describe('the control-plane triggers', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let relay: FakeRelay;
  const installs = new Map<string, ReturnType<typeof fakeInstall>>();
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const issuerScope = scopeId.parse(ulid());
  const otherScope = scopeId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  const installFor = (s: string) => {
    if (!installs.has(s)) installs.set(s, fakeInstall());
    return installs.get(s)!;
  };
  const vertical = {
    configureInstance: async (input: { scopeId: string; entries: { key: string; value: string }[] }) =>
      installFor(input.scopeId).configure(input.entries),
  } as unknown as VerticalClient;

  const api = (withRelay = true) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'auth-server': vertical, 'demo-vert': vertical },
      platformBaseDomains: ['substrat.run'],
      ...(withRelay ? { socialRelay: relay.options } : {}),
    });
  const call = (path: string, method: string, body?: unknown, app = api()) =>
    app.request(path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const bind = (hostname: string, s: string, app = api()) =>
    call('/hostnames', 'POST', { hostname, tenantId: t1, scopeId: s, surface: 'app', canonical: true }, app);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-social-relay-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t1, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: issuerScope, vertical: 'auth-server' });
    await host.admin.activateScope(staff, t1, issuerScope);
    await host.provisionScope(staff, { tenantId: t1, scopeId: otherScope, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, otherScope);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    relay = fakeRelay();
    installs.clear();
  });

  it('registers an Auth Server install when its platform hostname binds active — the install-time trigger', async () => {
    const res = await bind('login-acme.global.substrat.run', issuerScope);
    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('active');
    expect(relay.clients.get(`scope:${issuerScope}`)?.redirectUris).toEqual([
      'https://login-acme.global.substrat.run/api/auth/callback/github-relay',
    ]);
    expect(installFor(issuerScope).held?.clientId).toBe(relay.clients.get(`scope:${issuerScope}`)?.clientId);
  });

  it('does not reconcile again when a hostname that is already active is marked active', async () => {
    await bind('again-acme.global.substrat.run', issuerScope);
    const before = relay.calls.length;
    expect((await call('/hostnames/again-acme.global.substrat.run/status', 'PATCH', { status: 'active' })).status).toBe(200);
    expect(relay.calls.length).toBe(before);
  });

  it('leaves out a custom domain marked active by hand, which no provisioner verified', async () => {
    await bind('base-acme.global.substrat.run', issuerScope);
    await call('/hostnames', 'POST', { hostname: 'sso.acme.example', tenantId: t1, scopeId: issuerScope, surface: 'app', canonical: false });
    expect((await call('/hostnames/sso.acme.example/status', 'PATCH', { status: 'active' })).status).toBe(200);
    const uris = relay.clients.get(`scope:${issuerScope}`)?.redirectUris ?? [];
    expect(uris).toContain('https://base-acme.global.substrat.run/api/auth/callback/github-relay');
    expect(uris.some((u) => u.includes('sso.acme.example'))).toBe(false);
  });

  it('never calls the relay for another vertical’s hostname', async () => {
    expect((await bind('shop-acme.global.substrat.run', otherScope)).status).toBe(201);
    expect(relay.calls).toEqual([]);
  });

  it('binds the hostname all the same when the relay is down', async () => {
    relay.failNext = 503;
    const res = await bind('down-acme.global.substrat.run', issuerScope);
    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('active');
  });

  it('lets staff reconcile every Auth Server install, and one by one', async () => {
    const all = await call('/social-relay/reconcile', 'POST');
    expect(all.status).toBe(200);
    const body = (await all.json()) as { delivered: number; failed: number; results: { scopeId: string; status: string }[] };
    expect(body.failed).toBe(0);
    expect(body.results).toEqual([expect.objectContaining({ scopeId: issuerScope, status: 'delivered' })]);
    // Every active hostname of the install, the ones bound in the cases above included.
    expect(relay.clients.get(`scope:${issuerScope}`)?.redirectUris).toContain(
      'https://login-acme.global.substrat.run/api/auth/callback/github-relay',
    );

    const one = await call(`/tenants/${t1}/scopes/${otherScope}/social-relay`, 'POST');
    expect(await one.json()).toEqual({ status: 'skipped', reason: 'not an Auth Server install' });
  });

  it('answers 501 where no relay is configured, and stays silent on a bind', async () => {
    const bare = api(false);
    expect((await call('/social-relay/reconcile', 'POST', undefined, bare)).status).toBe(501);
    expect((await bind('bare-acme.global.substrat.run', issuerScope, bare)).status).toBe(201);
    expect(relay.calls).toEqual([]);
  });
});
