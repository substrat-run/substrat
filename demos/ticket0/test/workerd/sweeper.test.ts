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
 * state provisioning it once did. So is the fourth (#1648): a snooze pausing the resolution
 * target, read and written by the sweep's own schedules on a Durable Object's SQLite. So is
 * the fifth (#938): the live feed, whose frames come from the scope DO's fan-out.
 */
import { SELF, env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  permissionKey,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, type LiveChange } from '@substrat-run/kernel';
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

/**
 * #1648 on the runtime a hosted desk runs: a snooze pauses the resolution target, and the
 * sweep's two schedules — `wake-snoozed` and `escalate-sla-breaches` — read and write the
 * pause through a Durable Object's SQLite, over migration 0014's narrowed partial index.
 *
 * The DO host has no clock to move, so the instants are written into the desk's own
 * storage instead: a snooze that began, and a resolution due that fell, years ago. Each
 * pair differs in one column. The one whose snooze start is on record is paused: woken, its
 * due is pushed past now with no breach, and still asleep, the escalation's scan does not
 * see it. The one without — a conversation snoozed before the column existed — keeps the
 * clock it was snoozed under, and the same pass records it, awake or asleep. The asleep pair
 * is what reaches the scan: a pass wakes before it escalates, so a woken row has already
 * had its time back by the time the escalation reads it.
 */
describe('ticket0 on workerd — a snooze pauses the resolution target (#1648)', () => {
  const slaDesk = scopeId.parse(ulid());
  const SNOOZED_AT = '2020-01-01T00:00:00.000Z';
  /** Half an hour into that snooze: a due that fell while the conversation slept. */
  const DUE = '2020-01-01T00:30:00.000Z';
  const stub = () => env.SCOPE.get(env.SCOPE.idFromName(slaDesk));

  interface SlaRow extends Conversation {
    snoozed_at: string | null;
    snoozed_ms: number | null;
    resolution_due_at: string | null;
    resolution_breached_at: string | null;
  }

  beforeAll(async () => {
    expect((await platform('/internal/provision', { tenantId: t, scopeId: slaDesk, owner, entitlements })).status).toBe(201);
    await (await host().getScope(owner, t, slaDesk)).invoke('ticket0/configure-desk', {
      settings: { sla: { resolutionMinutes: { normal: 60 } } },
    });
  });

  afterAll(async () => {
    expect((await platform('/internal/delete-scope', { scopeId: slaDesk })).status).toBe(200);
  });

  /** Arrived, answered, snoozed until `until` — then its snooze and its due placed in 2020. */
  async function sleptSince(snoozedAt: string | null, until = PAST): Promise<string> {
    const id = await snoozedUntil(slaDesk, until);
    await runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec(
        `UPDATE ticket0_conversations
            SET first_public_reply_at = ?, resolution_due_at = ?, snoozed_at = ?
          WHERE id = ?`,
        SNOOZED_AT,
        DUE,
        snoozedAt,
        id,
      );
    });
    return id;
  }

  it('the migration narrowed the resolution index on the DO, and only that one', async () => {
    const sql = await runInDurableObject(stub(), (_i, state) =>
      Object.fromEntries(
        [
          ...state.storage.sql.exec(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'ticket0_conversations_%_running'",
          ),
        ].map((r) => [String(r.name), String(r.sql)]),
      ),
    );
    expect(sql['ticket0_conversations_resolution_running']).toMatch(/AND snoozed_at IS NULL$/);
    expect(sql['ticket0_conversations_first_response_running']).not.toMatch(/snoozed_at/);
  });

  it('a pass wakes a paused conversation past its due with the time back and no breach; an unpaused one is recorded', async () => {
    const paused = await sleptSince(SNOOZED_AT);
    const legacy = await sleptSince(null);
    // Still asleep after the pass, so the escalation's scan meets them snoozed: the
    // paused one must be outside it, and the legacy one inside it.
    const stillPaused = await sleptSince(SNOOZED_AT, FUTURE);
    const stillLegacy = await sleptSince(null, FUTURE);

    const before = Date.now();
    const report = await sweep();
    const after = Date.now();
    expect(report.errors).toEqual([]);
    expect(report.schedules.failed).toBe(0);

    const p = (await conversation(slaDesk, paused)) as SlaRow;
    expect(p).toMatchObject({ state: 'open', snoozed_at: null, resolution_breached_at: null });
    // Pushed back by exactly how long it slept, so it lands half an hour after the wake.
    const pushed = Date.parse(p.resolution_due_at!);
    expect(pushed).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(pushed).toBeLessThanOrEqual(after + 30 * 60_000);
    expect(pushed - Date.parse(DUE)).toBe(p.snoozed_ms);

    const l = (await conversation(slaDesk, legacy)) as SlaRow;
    expect(l.state).toBe('open');
    expect(l.resolution_due_at).toBe(DUE);
    expect(l.snoozed_ms).toBeNull();
    expect(l.resolution_breached_at).not.toBeNull();

    expect(await conversation(slaDesk, stillPaused)).toMatchObject({
      state: 'snoozed',
      snoozed_at: SNOOZED_AT,
      resolution_due_at: DUE,
      resolution_breached_at: null,
    });
    const sl = (await conversation(slaDesk, stillLegacy)) as SlaRow;
    expect(sl.state).toBe('snoozed');
    expect(sl.resolution_breached_at).not.toBeNull();
  });
});

/**
 * #1670 on the runtime a hosted desk runs: the platform's reconcile repairs the desk's entries
 * in a login's PLACES at the identity pool it signs in with. `onProvision` runs on
 * `/internal/reconcile`, and it sends the WHOLE set of subjects bound in the desk's directory
 * (the per-tenant `IdentityDO`), so an addition or a removal whose own report was lost is right
 * again after the next promote. The pool's half — what it keeps of such a report and why no one
 * else's list can be written — is pinned in `demos/auth-server/test/workerd/reconcile.test.ts`.
 *
 * The issuer is `fetchMock`: it answers where to report, and records the report.
 */
describe("ticket0 on workerd — a reconcile repairs the desk's places at its identity pool (#1670)", () => {
  const tenant = tenantId.parse(ulid());
  const desk = scopeId.parse(ulid());
  const ISSUER = 'https://auth.places.test';
  const directory = () => env.AUTH.get(env.AUTH.idFromName(tenant));

  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => fetchMock.deactivate());

  /** The next report the issuer receives, captured. */
  function nextReport(): { body: () => unknown } {
    let captured: unknown;
    fetchMock
      .get(ISSUER)
      .intercept({
        method: 'POST',
        path: '/api/places/report',
        body: (raw: string) => {
          captured = JSON.parse(raw);
          return true;
        },
      })
      .reply(204);
    return { body: () => captured };
  }

  it('sends the whole set bound in the desk, and a member unbound drops out of the next one', async () => {
    const install = { tenantId: tenant, scopeId: desk, owner, entitlements };
    expect((await platform('/internal/provision', install)).status).toBe(201);
    expect(
      (
        await platform('/internal/configure', {
          tenantId: tenant,
          scopeId: desk,
          entries: [
            {
              key: 'substrat:auth',
              value: JSON.stringify({ mode: 'oidc', issuer: ISSUER, clientId: 'desk-client', clientSecret: 'desk-secret' }),
            },
          ],
        })
      ).status,
    ).toBe(200);

    // Two bindings, made the two ordinary ways: the owner's first sign-in inside the window,
    // and an accepted invite.
    expect(await directory().resolvePrincipal(desk, 'sub-owner')).toBe(owner);
    const member = principalId.parse(ulid());
    await directory().createInvite(desk, member, 'agent', null, 'invite-hash');
    expect(await directory().claimInvite(desk, 'sub-ann', 'invite-hash')).toBe(member);

    fetchMock
      .get(ISSUER)
      .intercept({ method: 'GET', path: '/.well-known/substrat-places' })
      .reply(200, { report_endpoint: `${ISSUER}/api/places/report` });
    const first = nextReport();
    const { owner: _owner, ...reconcile } = install;
    expect((await platform('/internal/reconcile', reconcile)).status).toBe(200);
    fetchMock.assertNoPendingInterceptors();
    expect(first.body()).toEqual({
      client_id: 'desk-client',
      client_secret: 'desk-secret',
      scope_id: desk,
      op: 'replace',
      subs: ['sub-ann', 'sub-owner'],
    });

    // Ann is removed from the desk; say that report was lost. The next reconcile repairs it.
    expect(await directory().unbind(desk, 'sub-ann')).toBe(true);
    const second = nextReport();
    expect((await platform('/internal/reconcile', reconcile)).status).toBe(200);
    fetchMock.assertNoPendingInterceptors();
    expect(second.body()).toMatchObject({ op: 'replace', subs: ['sub-owner'] });

    expect((await platform('/internal/delete-scope', { scopeId: desk })).status).toBe(200);
  });
});

/**
 * #938 through the deployed worker: `GET /api/live`, the desk's change feed, reached the
 * way a browser reaches it (routed, signed in, an upgrade), with the frames arriving from
 * the scope's real fan-out. What a push must never do is tell someone about a thing they
 * could not have read by polling, so every negative here has a positive twin driven by the
 * SAME write, in the same moment:
 *
 *   - an internal note on a customer's own thread reaches the agent and not the customer,
 *     whose read-own reaches that thread's messages through the parent walk, and whose
 *     `my-messages` would never show them the note;
 *   - a follower, holding `conversation:read` narrowed onto ONE conversation, hears that
 *     conversation and not the one beside it;
 *   - a handshake from another origin is refused before anything is subscribed, and the
 *     same request from the desk's own origin is not.
 *
 * Signed in with a bearer the test signs itself, against a `fetchMock` issuer: the route
 * resolves a caller exactly as every other `/api` route does, and the bearer path is the
 * one of those a test can drive without a browser's cookie jar.
 */
describe("ticket0 on workerd — the live feed tells a subscriber only what they could read (#938)", () => {
  const tenant = tenantId.parse(ulid());
  const desk = scopeId.parse(ulid());
  const deskOwner = principalId.parse(ulid());
  const ISSUER = 'https://auth.live.test';
  const ORIGIN = 'https://desk.ticket0.test';
  const directory = () => env.AUTH.get(env.AUTH.idFromName(tenant));
  let signingKey: CryptoKey;

  const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  const encodeJson = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

  /** A bearer the issuer signed for `sub`. */
  async function bearerFor(sub: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const head = `${encodeJson({ alg: 'RS256', kid: 'live-1', typ: 'JWT' })}.${encodeJson({
      iss: ISSUER,
      sub,
      iat: now,
      exp: now + 300,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(head));
    return `${head}.${b64url(signature)}`;
  }

  /** The handshake, as the router forwards a browser's. */
  function handshake(headers: Record<string, string>): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/api/live`, {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'x-substrat-tenant': tenant,
        'x-substrat-scope': desk,
        'x-substrat-router': env.ROUTER_SECRET,
        ...headers,
      },
    });
  }

  /** Every socket a test opened, closed after it whether or not its assertions passed. */
  const open: WebSocket[] = [];
  afterEach(() => {
    for (const ws of open.splice(0)) ws.close(1000, 'test over');
  });

  /** A subscriber's open socket, and every frame it has received. */
  async function subscribe(sub: string): Promise<{ frames: LiveChange[] }> {
    const response = await handshake({ origin: ORIGIN, authorization: `Bearer ${await bearerFor(sub)}` });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    open.push(ws);
    const frames: LiveChange[] = [];
    ws.addEventListener('message', (event) => {
      const data = String((event as MessageEvent).data);
      if (data !== 'pong') frames.push(JSON.parse(data) as LiveChange);
    });
    return { frames };
  }

  /**
   * Let what the fan-out sent arrive. The fan-out is awaited inside the invoke, but a
   * socket delivers on a later turn. It is also what gives the negatives their teeth:
   * "nothing arrived" is asserted after the same wait in which something did arrive for
   * the positive twin.
   */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

  /** Bind `sub` to a new principal in this desk, holding `role`. */
  async function member(sub: string, role: string): Promise<PrincipalId> {
    const principal = principalId.parse(ulid());
    await directory().createInvite(desk, principal, role, null, `hash-${sub}`);
    expect(await directory().claimInvite(desk, sub, `hash-${sub}`)).toBe(principal);
    await host().assignScopeRole(desk, principal, role);
    return principal;
  }

  /** The desk's service accounts, as the worker's provision hook recorded them. */
  async function services(): Promise<{ relay: PrincipalId; widget: PrincipalId }> {
    const config = await directory().getScopeConfig(desk);
    const recorded = JSON.parse(config['ticket0:services']!) as { relay: string; widget: string };
    return { relay: principalId.parse(recorded.relay), widget: principalId.parse(recorded.widget) };
  }

  /** An entity-narrowed grant, as `ctx.grant` or an accepted portal invite writes one. */
  const grant = (who: PrincipalId, key: string, entityType: string, entityId: string) =>
    host().grantEntityLocal(desk, who, permissionKey.parse(key), { entityType, entityId });

  let mailed = 0;
  /** A conversation that arrived by mail from `email`: its id, and its contact's. */
  async function arrival(email: string): Promise<{ conversation: string; contact: string }> {
    const message = await (await host().getScope((await services()).relay, tenant, desk)).invoke<{ conversation_id: string }>(
      'ticket0/ingest-message',
      {
        conversationId: null,
        contactEmail: email,
        contactName: 'Live',
        subject: 'Is anyone there?',
        bodyText: 'Asking live.',
        emailMessageId: `<live-${(mailed += 1)}@mail.example>`,
      },
    );
    const conversation = await (await host().getScope(deskOwner, tenant, desk)).invoke<{ contact_id: string }>(
      'ticket0/get-conversation',
      { conversationId: message.conversation_id },
    );
    return { conversation: message.conversation_id, contact: conversation.contact_id };
  }

  const note = async (conversationId: string, body: string) =>
    (await host().getScope(deskOwner, tenant, desk)).invoke<{ id: string }>('ticket0/post-note', {
      conversationId,
      body,
    });

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    signingKey = pair.privateKey;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;

    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get(ISSUER)
      .intercept({ method: 'GET', path: '/.well-known/openid-configuration' })
      .reply(200, { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, authorization_endpoint: `${ISSUER}/authorize` })
      .persist();
    fetchMock
      .get(ISSUER)
      .intercept({ method: 'GET', path: '/jwks' })
      .reply(200, { keys: [{ ...jwk, alg: 'RS256', kid: 'live-1', use: 'sig' }] })
      .persist();

    const install = { tenantId: tenant, scopeId: desk, owner: deskOwner, entitlements };
    expect((await platform('/internal/provision', install)).status).toBe(201);
    expect(
      (
        await platform('/internal/configure', {
          tenantId: tenant,
          scopeId: desk,
          entries: [
            {
              key: 'substrat:auth',
              value: JSON.stringify({ mode: 'oidc', issuer: ISSUER, clientId: 'desk-client', clientSecret: 'desk-secret' }),
            },
          ],
        })
      ).status,
    ).toBe(200);
    // The owner's first sign-in, inside the window, claims the seat.
    expect(await directory().resolvePrincipal(desk, 'sub-owner')).toBe(deskOwner);
  });
  afterAll(() => fetchMock.deactivate());

  it("sends an agent the note on a customer's thread, and sends the customer nothing", async () => {
    await member('sub-agent', 'agent');
    const customer = await member('sub-customer', 'customer');
    const theirs = await arrival('customer@live.example');
    // The portal grant exactly as an accepted customer invite makes it: read-own on
    // their own contact, reaching their conversations through the parent edge.
    await grant(customer, 'conversation:read-own', 'contact', theirs.contact);
    // The customer really can read this thread by polling. So what they are denied
    // below is the note, not the conversation.
    const portal = await host().getScope(customer, tenant, desk);
    await expect(
      portal.invoke<Page<unknown>>('ticket0/my-messages', { conversationId: theirs.conversation }),
    ).resolves.toMatchObject({ entries: [expect.anything()] });

    const agentFeed = await subscribe('sub-agent');
    const customerFeed = await subscribe('sub-customer');
    const written = await note(theirs.conversation, 'Customer is on the enterprise plan; loop in billing.');
    await settle();

    // The negative first, so a break that sends the customer the note is reported as
    // exactly that, rather than hidden behind the agent's assertion failing too.
    expect(customerFeed.frames).toEqual([]);
    expect(agentFeed.frames).toContainEqual(
      expect.objectContaining({ kind: 'change', type: 'ticket0.note-posted', entityType: 'message', entityId: written.id }),
    );
    // And the note is exactly what polling keeps from them, which is why the push must.
    const polled = await portal.invoke<Page<{ id: string }>>('ticket0/my-messages', {
      conversationId: theirs.conversation,
    });
    expect(polled.entries.map((m) => m.id)).not.toContain(written.id);
  });

  it('sends a follower the conversation they follow, and not the one beside it', async () => {
    const follower = await member('sub-follower', 'customer');
    const followed = await arrival('followed@live.example');
    const beside = await arrival('beside@live.example');
    await grant(follower, 'conversation:read', 'conversation', followed.conversation);

    const feed = await subscribe('sub-follower');
    const onFollowed = await note(followed.conversation, 'Following along.');
    const onBeside = await note(beside.conversation, 'Not for the follower.');
    await settle();

    const ids = feed.frames.map((f) => f.entityId);
    expect(ids).toContain(onFollowed.id);
    expect(ids).not.toContain(onBeside.id);
  });

  it('stops a follower\'s frames the moment they are unfollowed, on the socket already open', async () => {
    await member('sub-unfollow-agent', 'agent');
    const follower = await member('sub-unfollowed', 'customer');
    const followed = await arrival('unfollow@live.example');
    await grant(follower, 'conversation:read', 'conversation', followed.conversation);

    const followerFeed = await subscribe('sub-unfollowed');
    const agentFeed = await subscribe('sub-unfollow-agent');
    const before = await note(followed.conversation, 'Still following.');
    await settle();
    expect(followerFeed.frames.map((f) => f.entityId)).toContain(before.id);

    // Unfollowed by the operation the desk uses, while the socket stays open.
    await (await host().getScope(deskOwner, tenant, desk)).invoke('ticket0/unfollow-conversation', {
      conversationId: followed.conversation,
      follower,
    });
    const after = await note(followed.conversation, 'Not following any more.');
    await settle();

    expect(followerFeed.frames.map((f) => f.entityId)).not.toContain(after.id);
    // The twin, from the same write: the agent still hears it.
    expect(agentFeed.frames.map((f) => f.entityId)).toContain(after.id);
  });

  /**
   * An assistant turn reaches a subscriber only if that subscriber can already poll it.
   * `ticket0/list-turns` is `conversation:read` on the turn's conversation, which a
   * follower narrowed onto that conversation holds and a portal customer does not (the
   * portal has no turns read at all). So each feed is asserted beside that subscriber's
   * own poll, and the frame must never be the wider of the two.
   *
   * For the follower the frame reaches the turn only by walking from `aiTurn:…` up to
   * its conversation. That walk used to throw on the camelCase entity type (#1856), and
   * the fan-out read the throw as a refusal, so the follower's feed was pinned `[]`. It
   * now carries exactly the followed turn, which is also what lets the conversation view
   * poll at the floor (`app/src/pace.ts`). An agent never needed the walk: a scope-wide
   * grant answers before it.
   */
  it("announces an assistant turn to exactly who could poll it: the follower, not the customer, not the thread beside it (#1856)", async () => {
    await member('sub-turn-agent', 'agent');
    const follower = await member('sub-turn-follower', 'customer');
    const customer = await member('sub-turn-customer', 'customer');
    const followed = await arrival('turns@live.example');
    const beside = await arrival('turns-beside@live.example');
    await grant(follower, 'conversation:read', 'conversation', followed.conversation);
    await grant(customer, 'conversation:read-own', 'contact', followed.contact);
    const { widget } = await services();
    // What the worker records when the assistant could not run: a turn, written by the
    // desk's widget service, on the customer's conversation.
    const failure = async (conversationId: string) =>
      (await host().getScope(widget, tenant, desk)).invoke<{ id: string }>('ticket0/record-assistant-failure', {
        conversationId,
        turnId: ulid(),
        model: 'test-model',
        error: 'no model configured',
      });

    const agentFeed = await subscribe('sub-turn-agent');
    const followerFeed = await subscribe('sub-turn-follower');
    const customerFeed = await subscribe('sub-turn-customer');
    const onFollowed = await failure(followed.conversation);
    const onBeside = await failure(beside.conversation);
    await settle();

    const turnsOf = (feed: { frames: LiveChange[] }) =>
      feed.frames.filter((f) => f.entityType === 'aiTurn').map((f) => f.entityId);
    const poll = async (who: PrincipalId, conversationId: string): Promise<string[] | 'refused'> => {
      try {
        const page = await (await host().getScope(who, tenant, desk)).invoke<Page<{ id: string }>>(
          'ticket0/list-turns',
          { conversationId },
        );
        return page.entries.map((t) => t.id);
      } catch {
        return 'refused';
      }
    };

    // The customer: no frame, and no poll that would have shown the turn.
    expect(customerFeed.frames).toEqual([]);
    expect(await poll(customer, followed.conversation)).toBe('refused');

    // The follower: whatever the feed carries, the poll already shows. The thread beside
    // is refused by both routes.
    const followerPolls = await poll(follower, followed.conversation);
    expect(followerPolls).toContain(onFollowed.id);
    for (const id of turnsOf(followerFeed)) expect(followerPolls).toContain(id);
    expect(await poll(follower, beside.conversation)).toBe('refused');
    expect(turnsOf(followerFeed)).not.toContain(onBeside.id);
    expect(turnsOf(followerFeed)).toEqual([onFollowed.id]); // #1856: the walk up from aiTurn answers

    // The positive twin, from the same two writes: an agent hears both turns.
    expect(turnsOf(agentFeed)).toEqual([onFollowed.id, onBeside.id]);
  });

  it("refuses a handshake from another origin, and takes the same one from the desk's own", async () => {
    const authorization = `Bearer ${await bearerFor('sub-owner')}`;
    const foreign = await handshake({ origin: 'https://other-tenant.ticket0.test', authorization });
    expect(foreign.status).toBe(403);
    expect(foreign.webSocket).toBeNull();

    const own = await handshake({ origin: ORIGIN, authorization });
    expect(own.status).toBe(101);
    own.webSocket!.accept();
    open.push(own.webSocket!);
  });

  it('refuses a handshake nobody signed in to', async () => {
    const anonymous = await handshake({ origin: ORIGIN });
    expect(anonymous.status).toBe(401);
    expect(anonymous.webSocket).toBeNull();
  });
});

/**
 * #1665 on the runtime a hosted desk runs: an owner hand-over through the deployed worker's
 * `/internal/owner-transfer`, against the desk's real identity directory and scope store, and
 * then the two re-seat paths a reconcile has. The ordinary reconcile re-sources its owner
 * from `owner_of_record`, and the lockout repair (#1659) re-seats that owner when nobody else
 * holds an effective role. After a hand-over both must name the NEW owner: the old one is
 * never re-seated by either, and the new one comes back from a lockout.
 *
 * The twin is the hand-over this verb replaces: seat the successor and revoke the owner by
 * hand. The record never moves, so the same lockout brings the ORIGINAL owner back. That is
 * the #1665 bug, and it is what makes the first test able to fail.
 */
describe('ticket0 on workerd — an owner hand-over moves the owner the lockout repair re-seats (#1665)', () => {
  const tenant = tenantId.parse(ulid());
  const A = principalId.parse(ulid());
  const B = principalId.parse(ulid());
  const directory = () => env.AUTH.get(env.AUTH.idFromName(tenant));
  const scopeStub = (s: ScopeId) => env.SCOPE.get(env.SCOPE.idFromName(s));

  /** Whether `who` can act as the desk's admin: its settings write, which only desk-admin holds. */
  async function canAdmin(who: PrincipalId, s: ScopeId): Promise<boolean> {
    try {
      await (await host().getScope(who, tenant, s)).invoke('ticket0/configure-desk', {
        settings: { sla: { resolutionMinutes: { normal: 60 } } },
      });
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === 'PermissionDenied') return false;
      throw e;
    }
  }
  /** Who holds a LIVE owner-role tuple in the desk's own storage. */
  const ownerSeats = (s: ScopeId): Promise<string[]> =>
    runInDurableObject(scopeStub(s), async (_instance, state) =>
      [
        ...state.storage.sql.exec(
          `SELECT subject FROM _substrat_tuples
            WHERE relation = 'role:desk-admin' AND object = ? AND revoked_at IS NULL ORDER BY subject`,
          `scope:${s}`,
        ),
      ].map((r) => String(r.subject).slice('principal:'.length)),
    );

  /**
   * Take back every live role in the desk: the lockout the repair exists for. Revoking the
   * owner alone is not one here, because the desk's service principals (relay, widget,
   * assistant) each hold a role of their own and count as holders.
   */
  async function revokeEveryRole(s: ScopeId): Promise<void> {
    const live = await runInDurableObject(scopeStub(s), async (_instance, state) =>
      [
        ...state.storage.sql.exec(
          `SELECT subject, relation FROM _substrat_tuples
            WHERE relation LIKE 'role:%' AND object = ? AND revoked_at IS NULL`,
          `scope:${s}`,
        ),
      ].map((r) => ({ who: String(r.subject).slice('principal:'.length), role: String(r.relation).slice('role:'.length) })),
    );
    expect(live.length).toBeGreaterThan(0);
    for (const { who, role } of live) expect(await host().revokeScopeRole(s, principalId.parse(who), role)).toBe(true);
  }

  /** B made a member the way an invite does: the role granted, then the invite accepted. */
  async function member(s: ScopeId, who: PrincipalId): Promise<void> {
    await host().assignScopeRole(s, who, 'agent');
    await directory().createInvite(s, who, 'agent', null, `hash-${s}-${who}`);
    expect(await directory().claimInvite(s, `sub-${who}-${s}`, `hash-${s}-${who}`)).toBe(who);
  }

  /** A desk A installed and signed in to, with B a member by an accepted invite. */
  async function installed(): Promise<ScopeId> {
    const s = scopeId.parse(ulid());
    expect((await platform('/internal/provision', { tenantId: tenant, scopeId: s, owner: A, entitlements })).status).toBe(201);
    expect(await directory().resolvePrincipal(s, `sub-a-${s}`)).toBe(A);
    await member(s, B);
    return s;
  }
  const reconcile = (s: ScopeId) => platform('/internal/reconcile', { tenantId: tenant, scopeId: s, entitlements });
  const transfer = (s: ScopeId, from: string, to: string) =>
    platform('/internal/owner-transfer', { tenantId: tenant, scopeId: s, from, to });

  it('after A hands to B, a reconcile keeps A out, and a lockout repair re-seats B, not A', async () => {
    const s = await installed();
    expect(await ownerSeats(s)).toEqual([A]);

    const res = await transfer(s, A, B);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scopeId: s, from: A, owner: B, outcome: 'transferred', fromRevoked: true });
    expect(await directory().getOwnerOfRecord(s)).toBe(B);
    expect((await directory().ownerSeat(s)).state).toBe('claimed'); // a claimed seat stays claimed
    expect(await ownerSeats(s)).toEqual([B]);
    expect(await canAdmin(B, s)).toBe(true);
    expect(await canAdmin(A, s)).toBe(false);

    // The ordinary reconcile, which every listed promote runs: B stays, A does not come back.
    expect((await reconcile(s)).status).toBe(200);
    expect(await ownerSeats(s)).toEqual([B]);
    expect(await canAdmin(A, s)).toBe(false);

    // The lockout: B revoked too, with every other role, nobody seated in between. The repair
    // re-seats the RECORD.
    await revokeEveryRole(s);
    expect(await canAdmin(B, s)).toBe(false); // locked out: nobody here passes a check
    const repaired = await reconcile(s);
    expect(repaired.status).toBe(200);
    expect(((await repaired.json()) as { owner: string }).owner).toBe(B);
    expect(await ownerSeats(s)).toEqual([B]);
    expect(await canAdmin(B, s)).toBe(true);
    expect(await canAdmin(A, s)).toBe(false);

    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it('after A hands to B, a re-provision (the install re-run) repairs a lockout with B, not A', async () => {
    const s = await installed();
    expect((await transfer(s, A, B)).status).toBe(200);
    await revokeEveryRole(s);
    // The platform re-sends `/internal/provision` with the owner it minted at install: A.
    const res = await platform('/internal/provision', { tenantId: tenant, scopeId: s, owner: A, entitlements });
    expect(res.status).toBe(201);
    expect(await ownerSeats(s)).toEqual([B]);
    expect(await canAdmin(B, s)).toBe(true);
    expect(await canAdmin(A, s)).toBe(false);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it('the twin: a hand-over by hand leaves the record on A, so the same lockout brings A back', async () => {
    const s = await installed();
    await host().assignScopeRole(s, B, 'desk-admin'); // B seated first, as #1659 advises
    expect(await host().revokeScopeRole(s, A, 'desk-admin')).toBe(true);
    await revokeEveryRole(s); // later B too, and with it the desk's last holder
    expect((await reconcile(s)).status).toBe(200);
    expect(await directory().getOwnerOfRecord(s)).toBe(A);
    expect(await ownerSeats(s)).toEqual([A]); // the original owner, re-seated from a stale record
    expect(await canAdmin(A, s)).toBe(true);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it('refuses a stale `from` and a non-member `to` with nothing moved; a repeat changes nothing', async () => {
    const s = await installed();
    const stranger = principalId.parse(ulid());
    expect((await transfer(s, stranger, B)).status).toBe(409); // `from` is not the record
    expect((await transfer(s, A, stranger)).status).toBe(409); // nobody is bound to `to`
    expect(await directory().getOwnerOfRecord(s)).toBe(A);
    expect(await ownerSeats(s)).toEqual([A]);

    expect((await transfer(s, A, B)).status).toBe(200);
    const again = await transfer(s, A, B);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ owner: B, outcome: 'done', fromRevoked: false });
    expect(await ownerSeats(s)).toEqual([B]);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it('refuses a member whose role was taken back (still signed in), and hands to them once it is back', async () => {
    const s = await installed();
    expect(await host().revokeScopeRole(s, B, 'agent')).toBe(true); // removed, binding kept
    const res = await transfer(s, A, B);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/holding no role here — grant `to` a role first/);
    expect(await directory().getOwnerOfRecord(s)).toBe(A);
    expect(await ownerSeats(s)).toEqual([A]);
    await host().assignScopeRole(s, B, 'agent'); // the twin: a member again
    expect((await transfer(s, A, B)).status).toBe(200);
    expect(await ownerSeats(s)).toEqual([B]);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it('a request naming another owner-role holder as `from` revokes nobody, open or closed (review MAJOR)', async () => {
    const s = await installed();
    const C = principalId.parse(ulid());
    await member(s, C);
    await host().assignScopeRole(s, C, 'desk-admin'); // a second holder of the owner role
    expect((await transfer(s, A, B)).status).toBe(200);
    // The record names B. `{ from: C, to: B }` is no retry of that hand-over.
    const res = await transfer(s, C, B);
    expect(res.status).toBe(409);
    expect(await ownerSeats(s)).toEqual([B, C].sort());
    expect(await canAdmin(C, s)).toBe(true);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it('a hand-over wedged by removing `to` is refused with nothing seated; an abandon clears it', async () => {
    const s = await installed();
    const C = principalId.parse(ulid());
    await member(s, C);
    // Step 1 ran and the flow stopped: the record names B, the hand-over is open.
    expect((await directory().transferOwner(s, A, B, true)).outcome).toBe('transferred');
    const abandon = (from: string, to: string) =>
      platform('/internal/owner-transfer', { tenantId: tenant, scopeId: s, from, to, abandon: true });
    // While B can still take it, it is not wedged: an abandon is refused — resend it instead.
    const healthy = await abandon(A, B);
    expect(healthy.status).toBe(409);
    expect(((await healthy.json()) as { error: string }).error).toMatch(/resend it instead/);
    expect(await host().revokeScopeRole(s, B, 'agent')).toBe(true); // then the tenant removed B
    const resend = await transfer(s, A, B);
    expect(resend.status).toBe(409);
    expect(((await resend.json()) as { error: string }).error).toMatch(/can no longer finish/);
    expect(await ownerSeats(s)).toEqual([A]); // B was not seated
    expect((await transfer(s, B, C)).status).toBe(409); // stuck behind it
    expect((await abandon(B, C)).status).toBe(409); // not the open pair
    const abandoned = await abandon(A, B);
    expect(abandoned.status).toBe(200);
    expect(await abandoned.json()).toMatchObject({ outcome: 'abandoned', owner: B, fromRevoked: false });
    expect(await ownerSeats(s)).toEqual([A]);
    // From the record (B), a fresh hand-over goes through.
    expect((await transfer(s, B, C)).status).toBe(200);
    expect(await directory().getOwnerOfRecord(s)).toBe(C);
    expect(await ownerSeats(s)).toContain(C);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it("refuses the desk's own service accounts as `to` — each holds a role, and no login is theirs", async () => {
    const s = await installed();
    const recorded = JSON.parse((await directory().getScopeConfig(s))['ticket0:services']!) as Record<string, string>;
    const accounts = Object.values(recorded).map((p) => principalId.parse(p));
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      const res = await transfer(s, A, account);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/no login in it is bound to `to`/);
    }
    expect(await directory().getOwnerOfRecord(s)).toBe(A);
    expect(await ownerSeats(s)).toEqual([A]);
    expect((await transfer(s, A, B)).status).toBe(200); // the twin: a member who signs in
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });

  it('refuses an unclaimed seat, and leaves it claimable by the owner it was minted for', async () => {
    const s = scopeId.parse(ulid());
    expect((await platform('/internal/provision', { tenantId: tenant, scopeId: s, owner: A, entitlements })).status).toBe(201);
    await member(s, B);
    const res = await transfer(s, A, B);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/claim it first/);
    expect((await directory().ownerSeat(s)).state).toBe('unclaimed');
    expect(await directory().resolvePrincipal(s, `sub-a-${s}`)).toBe(A);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });
});
