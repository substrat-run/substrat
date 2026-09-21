/**
 * A hosted desk's schedules fire (#1646) — in workerd, through the deployed worker.
 *
 * `src/worker.ts` is what `substrat push` uploads, and until #1646 nothing in it ran the
 * four schedules `src/manifest.ts` declares: the control plane's cron sweeps a host with
 * no modules, and a dispatch script's own cron is not honoured. So a snooze lasted until
 * somebody pressed Wake, and every other suite in this package stayed green, because they
 * drive the module on the node host and call the timer themselves.
 *
 * This suite drives the worker the way the platform does — `/internal/provision`,
 * `/internal/reconcile`, `/internal/restore`, `/internal/delete-scope`, with the platform
 * secret — and then runs a pass of the deployment's own sweeper, the one its alarm runs
 * every two minutes. What it holds:
 *
 *   - a provisioned desk is on the roster, and a pass wakes its due snooze while a snooze
 *     that is not due yet stays put;
 *   - a desk provisioned BEFORE the sweeper existed — every live desk, the moment this
 *     deploys — is not swept until a reconcile notes it, and then is;
 *   - a desk RESTORED from another's dump (the PR-preview path: a fork of production data)
 *     is never on the roster, even once routed traffic has reached it. The sweeper keeps
 *     no roster from traffic, and this is the test that notices if one ever does;
 *   - deleting a desk takes it off the roster.
 *
 * Time is not moved here: the DO host has no injectable clock (`clock?: never`), so the
 * due snooze is one set in the past — which `ticket0/snooze` accepts, as it must for a
 * snooze whose moment passed while the request was in flight.
 *
 * The second `describe` (#1655) is not about the sweeper: it holds the two search reads to
 * the 50-byte pattern limit a Durable Object's SQLite enforces and Node's does not. It is in
 * THIS file because the pool re-evaluates the worker's main module for every test file, and
 * a Durable Object a previous file left alive answers its first call with "changed,
 * invalidating this Durable Object" — measured, as a 400 from `/internal/provision`, whose
 * roster note reaches the one sweeper DO both files share. One file, one module instance.
 * The third (#1653) is here for the same reason: provisioning a desk twice must leave the
 * state provisioning it once did.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  CloudflareScopeHost,
  SCOPE_SWEEPER_NAME,
  type ScopeSweepReport,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import { classifyError } from '@substrat-run/vertical-host';
import { MODULES } from '../../src/provision.js';

interface Conversation {
  id: string;
  state: string;
  snoozed_until: string | null;
}

const t = tenantId.parse(ulid());
const owner = principalId.parse(ulid());
/** A desk provisioned after this change — the ordinary install. */
const desk = scopeId.parse(ulid());
/** A desk provisioned before the sweeper existed. */
const legacy = scopeId.parse(ulid());
/** A copy of `legacy`, restored the way a PR preview is — never provisioned. */
const fork = scopeId.parse(ulid());

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

/** What a dashboard install projects into a desk, as `vitest.workers.config.ts` derived it. */
const entitlements = (JSON.parse(env.TEST_INSTALL_ENTITLEMENTS) as string[]).map((entitlementKey) => ({
  entitlementKey,
  expiresAt: null,
  quota: null,
  plan: null,
  grantedAt: null,
  grantedBy: null,
}));

/** The same host the worker builds — the test's door into a desk's operations. */
function host(): CloudflareScopeHost {
  const h = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) h.registerModule(m);
  return h;
}

/** A platform call, as the control plane makes it. */
function platform(path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`https://ticket0.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sweeper(): DurableObjectStub & ScopeSweeperDo {
  return env.SWEEPER.get(env.SWEEPER.idFromName(SCOPE_SWEEPER_NAME)) as DurableObjectStub & ScopeSweeperDo;
}

/** The scopes on the sweeper's roster, read out of its own storage. */
function roster(): Promise<string[]> {
  return runInDurableObject(sweeper(), async (_instance, state) =>
    [...(await state.storage.list({ prefix: 'scope:' })).keys()].map((k) => k.slice('scope:'.length)),
  );
}

/** One pass of the deployment's own sweeper — what its alarm runs. */
async function sweep(): Promise<ScopeSweepReport> {
  const outcome = await sweeper().sweepNow();
  if ('error' in outcome) throw new Error(`the pass sank whole: ${outcome.error}`);
  return outcome;
}

/** The desk's relay account, minted by the worker's own provision hook. */
async function relayOf(s: ScopeId): Promise<PrincipalId> {
  const config = await env.AUTH.get(env.AUTH.idFromName(t)).getScopeConfig(s);
  return principalId.parse((JSON.parse(config['ticket0:services']!) as { relay: string }).relay);
}

let arrivals = 0;

/** A conversation that arrived by mail, was opened, and was snoozed until `until`. */
async function snoozedUntil(s: ScopeId, until: string): Promise<string> {
  const relay = await host().getScope(await relayOf(s), t, s);
  const arrived = await relay.invoke<{ conversation_id: string }>('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: 'later@customer.example',
    contactName: 'Later',
    subject: 'Something for later',
    bodyText: 'No rush on this one.',
    emailMessageId: `<later-${(arrivals += 1)}@mail.example>`,
  });
  const admin = await host().getScope(owner, t, s);
  await admin.invoke('ticket0/assign', { conversationId: arrived.conversation_id, assignee: null });
  const row = await admin.invoke<Conversation>('ticket0/snooze', {
    conversationId: arrived.conversation_id,
    until,
  });
  expect(row.state).toBe('snoozed');
  return row.id;
}

async function conversation(s: ScopeId, id: string): Promise<Conversation> {
  return (await host().getScope(owner, t, s)).invoke<Conversation>('ticket0/get-conversation', {
    conversationId: id,
  });
}

describe('ticket0 on workerd — the deployment sweeps its own desks (#1646)', () => {
  beforeAll(async () => {
    // Nothing noted yet: no roster, no loop. A deployment with no desks costs nothing.
    expect(await roster()).toEqual([]);
  });

  it('provisioning a desk puts it on the roster and starts the loop', async () => {
    const res = await platform('/internal/provision', { tenantId: t, scopeId: desk, owner, entitlements });
    expect(res.status).toBe(201);
    expect(await roster()).toEqual([desk]);
    expect(await runInDurableObject(sweeper(), (_i, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it('a pass wakes the snooze that is due, and leaves the one that is not', async () => {
    const due = await snoozedUntil(desk, PAST);
    const notYet = await snoozedUntil(desk, FUTURE);

    const report = await sweep();
    expect(report.errors).toEqual([]);
    expect(report.scopes).toBe(1);
    // A desk's first pass runs every schedule it declares once — wake-snoozed,
    // reap-abandoned, assign-round-robin, escalate-sla-breaches — and none fails under
    // the entitlements a real install projects.
    expect(report.schedules).toEqual({ scopes: 1, fired: 4, skipped: 0, failed: 0 });

    expect(await conversation(desk, due)).toMatchObject({ state: 'open', snoozed_until: null });
    expect(await conversation(desk, notYet)).toMatchObject({ state: 'snoozed', snoozed_until: FUTURE });
  });

  it('a desk provisioned before the sweeper existed joins on reconcile; a restored copy never does', async () => {
    // The state of every live desk the moment this deploys: provisioned, and never noted.
    expect((await platform('/internal/provision', { tenantId: t, scopeId: legacy, owner, entitlements })).status).toBe(201);
    await sweeper().forgetScope(legacy);
    expect(await roster()).toEqual([desk]);
    const due = await snoozedUntil(legacy, PAST);

    // The PR-preview path: dump the desk, restore the dump into a new scope id. Nothing
    // provisions a fork, so nothing notes it.
    const dump = await (await platform(`/internal/export?scopeId=${legacy}`)).json();
    expect((await platform('/internal/restore', { tenantId: t, scopeId: fork, tables: dump })).status).toBe(200);
    // …and traffic reaches it, as a preview hostname sends it: a routed request through
    // the worker, and a read served by the fork's own scope DO.
    const routed = await SELF.fetch('https://preview.ticket0.test/api/me', {
      headers: {
        'x-substrat-tenant': t,
        'x-substrat-scope': fork,
        'x-substrat-router': env.ROUTER_SECRET,
      },
    });
    // The worker took the node from the assertion and answered as that instance — which,
    // with no issuer delivered to it, is its own refusal to sign anybody in. Not the 400 of
    // a bad assertion, nor the 503 of a missing one: the request reached the fork.
    expect(await routed.json()).toMatchObject({ instance: '/api/me', detail: expect.stringMatching(/OIDC_ISSUER/) });
    expect((await conversation(fork, due)).state).toBe('snoozed');

    // Before the reconcile, a pass reaches neither: the due snooze on the legacy desk
    // stays asleep — which is exactly the bug, on every desk, until this lands.
    await sweep();
    expect(await roster()).toEqual([desk]);
    expect((await conversation(legacy, due)).state).toBe('snoozed');

    // The reconcile #1172 runs after a push (or "Re-run provisioning" in the console).
    const reconciled = await platform('/internal/reconcile', { tenantId: t, scopeId: legacy, entitlements });
    expect(reconciled.status).toBe(200);
    expect((await roster()).sort()).toEqual([desk, legacy].sort());

    const report = await sweep();
    expect(report.errors).toEqual([]);
    expect(await conversation(legacy, due)).toMatchObject({ state: 'open', snoozed_until: null });
    // The copy holds the same due snooze and its schedules have never run, so a pass
    // that reached it would wake it. It is not reached.
    expect(await roster()).not.toContain(fork);
    expect((await conversation(fork, due)).state).toBe('snoozed');
  });

  it('deleting a desk takes it off the roster', async () => {
    const res = await platform('/internal/delete-scope', { scopeId: desk });
    expect(res.status).toBe(200);
    expect(await roster()).toEqual([legacy]);
    expect((await sweep()).scopes).toBe(1);
  });
});

/** What a Durable Object's SQLite refuses a `LIKE` pattern beyond — asked of the runtime below. */
const LIKE_LIMIT = 50;

/** The pattern sent for a term, in UTF-8 bytes — written out here, not taken from the model. */
const patternBytes = (term: string) =>
  new TextEncoder().encode(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`).length;

/** Each is the longest term of its kind: the pattern sent is exactly 50 bytes. */
const AT_THE_LIMIT = {
  ascii: 'limit-'.padEnd(48, 'x'),
  // 24 characters, 48 bytes — under any character count that would let ASCII through.
  'two-byte letters': 'å'.repeat(24),
  // 24 characters, 48 bytes once each carries its escape.
  'escaped wildcards': '%'.repeat(24),
} as const;

/** The same kind of term, one character longer — 51, 52 and 52 bytes of pattern (a `%` is 2 + 2 wrappers). */
const ONE_OVER = {
  ascii: `${AT_THE_LIMIT.ascii}x`,
  'two-byte letters': `${AT_THE_LIMIT['two-byte letters']}å`,
  'escaped wildcards': `${AT_THE_LIMIT['escaped wildcards']}%`,
} as const;

const KINDS = Object.keys(AT_THE_LIMIT) as (keyof typeof AT_THE_LIMIT)[];

describe('ticket0 on workerd — a search term the desk\'s database can run (#1655)', () => {
  /** Its own desk, provisioned and deleted inside this block. */
  const searchDesk = scopeId.parse(ulid());

  beforeAll(async () => {
    const res = await platform('/internal/provision', { tenantId: t, scopeId: searchDesk, owner, entitlements });
    expect(res.status).toBe(201);
    const ingest = await host().getScope(await relayOf(searchDesk), t, searchDesk);
    for (const [i, kind] of KINDS.entries()) {
      const term = AT_THE_LIMIT[kind];
      await ingest.invoke('ticket0/ingest-message', {
        conversationId: null,
        contactEmail: `bound-${i}@customer.example`,
        contactName: term,
        subject: term,
        bodyText: 'Probing the search bound.',
        emailMessageId: `<bound-${i}@mail.example>`,
      });
    }
  });

  // Off the roster again, so what the block above asserted about it stays true of the file.
  afterAll(async () => {
    expect((await platform('/internal/delete-scope', { scopeId: searchDesk })).status).toBe(200);
  });

  it('the runtime accepts a 50-byte pattern and refuses a 51-byte one', async () => {
    const stub = env.SCOPE.get(env.SCOPE.idFromName(searchDesk));
    const like = (pattern: string) =>
      runInDurableObject(stub, (_i, state) =>
        state.storage.sql.exec("SELECT 'a' LIKE ? ESCAPE '\\'", pattern).toArray(),
      );
    await expect(like('%'.padEnd(LIKE_LIMIT, 'a'))).resolves.toBeDefined();
    await expect(like('%'.padEnd(LIKE_LIMIT + 1, 'a'))).rejects.toThrow(/too complex/);
  });

  it('the patterns under test are exactly at the limit, and one over it', () => {
    for (const kind of KINDS) {
      expect(patternBytes(AT_THE_LIMIT[kind])).toBe(LIKE_LIMIT);
      expect(patternBytes(ONE_OVER[kind])).toBeGreaterThan(LIKE_LIMIT);
    }
    // The counts the comment above states, held rather than trusted.
    expect(KINDS.map((kind) => patternBytes(ONE_OVER[kind]))).toEqual([51, 52, 52]);
    // The point of a byte bound: 24 letters against 48 is far from a character limit.
    expect(AT_THE_LIMIT['two-byte letters'].length).toBe(24);
  });

  it.each(KINDS)('%s — a term at the limit is found by both searches', async (kind) => {
    const term = AT_THE_LIMIT[kind];
    const admin = await host().getScope(owner, t, searchDesk);
    const conversations = await admin.invoke<Page<{ subject: string | null }>>('ticket0/search-conversations', {
      q: term,
    });
    expect(conversations.entries.map((c) => c.subject)).toEqual([term]);
    const people = await admin.invoke<Page<{ display_name: string | null }>>('ticket0/search-contacts', {
      q: term,
    });
    expect(people.entries.map((c) => c.display_name)).toEqual([term]);
  });

  it.each(KINDS)('%s — a term one over is a 400 naming the limit, not a database error', async (kind) => {
    const admin = await host().getScope(owner, t, searchDesk);
    for (const op of ['ticket0/search-conversations', 'ticket0/search-contacts']) {
      const refused = await admin.invoke(op, { q: ONE_OVER[kind] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(refused, `${op} accepted a term over the bound`).toBeInstanceOf(Error);
      const message = (refused as Error).message;
      // The refinement's own words — and not what the database says when it is the one
      // to refuse: `LIKE or GLOB pattern too complex: SQLITE_ERROR`.
      expect(message).toMatch(/48 bytes/);
      expect(message).not.toMatch(/too complex|SQLITE/);
      // What `mountOperations` would answer with, from the error as it crosses the
      // Durable Object hop: the caller's mistake, not a fault of the runtime.
      expect(classifyError(refused)).toMatchObject({ status: 400 });
      expect(classifyError(refused)?.platformFault).toBeUndefined();
    }
  });
});

/**
 * Provisioning a desk twice leaves exactly the state provisioning it once did (#1653). In
 * this file rather than its own because the pool invalidates live Durable Objects between
 * test files, and this suite's cases share one deployment's roster.
 *
 * Idempotence was always the contract (`mountPlatformSurface`: "`onProvision` is required
 * to be idempotent"), but little leaned on it: a desk was reconciled when an operator
 * pressed "Re-run provisioning", or once after a push moved its version. Since #1653 the
 * platform reconciles every install of a vertical each time the code it RUNS changes —
 * for a listed vertical, every tenant's install, after every promote, with nobody
 * watching. A hook that minted a second service account, re-opened the owner's
 * first-sign-in window, or re-sent anything would do it to every live desk at once.
 *
 * So this compares the WHOLE of what a provision writes — every table in the desk's scope
 * database, every table in its tenant's identity directory, and the sweeper roster — after
 * one `/internal/provision`, and again after a second provision (the platform-intent
 * drain's retry) and two `/internal/reconcile`s (the sweep, twice). Row for row.
 */
describe('ticket0 provision is idempotent (#1653)', () => {
  const tenant = tenantId.parse(ulid());
  const fresh = scopeId.parse(ulid());
  const install = { tenantId: tenant, scopeId: fresh, owner, entitlements };

  /** Every row of every table in one Durable Object's SQLite, order-free. */
  const tablesOf = (stub: DurableObjectStub): Promise<Record<string, string[]>> =>
    runInDurableObject(stub, async (_instance, state) => {
      const names = [
        ...state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        ),
      ].map((r) => String(r.name));
      const out: Record<string, string[]> = {};
      for (const name of names) {
        out[name] = [...state.storage.sql.exec(`SELECT * FROM "${name}"`)].map((r) => JSON.stringify(r)).sort();
      }
      return out;
    });

  const everything = async () => ({
    scope: await tablesOf(env.SCOPE.get(env.SCOPE.idFromName(fresh))),
    identity: await tablesOf(env.AUTH.get(env.AUTH.idFromName(tenant))),
    roster: await runInDurableObject(sweeper(), async (_instance, state) =>
      Object.fromEntries(await state.storage.list({ prefix: 'scope:' })),
    ),
  });

  it('a second provision and two reconciles leave every row exactly as one provision did', async () => {
    expect((await platform('/internal/provision', install)).status).toBe(201);
    const once = await everything();

    // The drain's retry, then the sweep reaching the desk on two promotes.
    expect((await platform('/internal/provision', install)).status).toBe(201);
    for (let i = 0; i < 2; i++) {
      const { owner: _owner, ...reconcile } = install;
      expect((await platform('/internal/reconcile', reconcile)).status).toBe(200);
    }
    const again = await everything();

    // The comparison is only worth something if the first provision wrote things: the
    // service accounts' role tuples, the owner seat, the desk on the roster.
    expect(once.scope['_substrat_tuples']!.length).toBeGreaterThan(1);
    expect(once.identity['owner_of_record']).toHaveLength(1);
    expect(once.identity['pending_owner']).toHaveLength(1);
    expect(Object.keys(once.roster)).toContain(`scope:${fresh}`);

    expect(again).toEqual(once);
    expect((await platform('/internal/delete-scope', { scopeId: fresh })).status).toBe(200);
  });
});
