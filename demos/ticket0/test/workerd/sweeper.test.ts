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
 * the fifth (#938): the live feed, whose frames come from the scope DO's fan-out. And the
 * business-hours describe after #1648's (also #1648): the zone data `Intl` reads is the
 * runtime's own, so the DST answers are proven where a hosted desk computes them.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  moduleId,
  permissionKey,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { STORE_LOCAL_META_KEYS, listIndexMigrations, ulid, type LiveChange, type LiveFrame, type ModuleErasureCounts } from '@substrat-run/kernel';
import {
  CloudflareScopeHost,
  SCOPE_SWEEPER_NAME,
  defineScopeDO,
  type ScopeSweepReport,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import { classifyError } from '@substrat-run/vertical-host';
import { addBusinessMs, businessMsBetween, instantOf } from '../../src/business-time.js';
import { ticket0Manifest } from '../../src/manifest.js';
import { MODULES } from '../../src/provision.js';
import { ticket0Migrations } from '../../src/migrations.generated.js';
import { INBOX_PARTIAL_INDEXES, listsBefore0021 } from '../before-0021.js';
import { listsBefore0027 } from '../before-0027.js';
import { DESK_TABLES, populateDesk } from '../desk-fixture.js';
import { checkTicket0SubjectErasure, type ErasureSql } from '../subject-erasure-case.js';
import { DESK_READS, INBOX_PAGES, SUSPENDED_QUEUE, planUsesIndex, sorts, type Shape } from '../desk-read-shapes.js';

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
    // reap-abandoned, assign-round-robin, escalate-sla-breaches, and (#1083) auto-tag,
    // auto-close, notify-no-reply — and none fails under the entitlements a real install
    // projects.
    expect(report.schedules).toEqual({ scopes: 1, fired: 7, skipped: 0, failed: 0 });

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
        // #1722: the store's own bookkeeping (its load stamp and write revision) moves with every
        // write, an idempotent one included. It is not the scope's data, so it is not compared.
        const rows = [...state.storage.sql.exec(`SELECT * FROM "${name}"`)].filter(
          (r) => name !== '_substrat_meta' || !STORE_LOCAL_META_KEYS.includes(String(r.key)),
        );
        out[name] = rows.map((r) => JSON.stringify(r)).sort();
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
    // #1088 (0021) narrowed it again, to the inbox; the snooze term is still in it.
    expect(sql['ticket0_conversations_resolution_running']).toMatch(/AND snoozed_at IS NULL AND quarantine IS NULL$/);
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
 * #1648's business hours, on the runtime a hosted desk runs. The arithmetic resolves
 * wall-clock times through `Intl.DateTimeFormat`, and the zone data behind that is the
 * RUNTIME's, not the package's: a workerd whose ICU lacked a zone, or resolved a DST gap
 * differently, would put every business-time due somewhere node never did. So the DST facts
 * `test/business-time.test.ts` pins on node are asserted again here, and a desk on the
 * business clock stamps an arriving conversation on the DO.
 */
describe('ticket0 on workerd — business hours run on the runtime\'s own zone data (#1648)', () => {
  const bhDesk = scopeId.parse(ulid());
  const HOUR = 3_600_000;
  const nineToFive = [{ open: '09:00', close: '17:00' }];
  const hours = {
    timezone: 'Europe/Stockholm',
    weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive },
  };

  beforeAll(async () => {
    expect((await platform('/internal/provision', { tenantId: t, scopeId: bhDesk, owner, entitlements })).status).toBe(201);
    await (await host().getScope(owner, t, bhDesk)).invoke('ticket0/configure-desk', {
      settings: { businessHours: hours, sla: { firstResponseMinutes: { normal: 240 }, clock: 'business' } },
    });
  });

  afterAll(async () => {
    expect((await platform('/internal/delete-scope', { scopeId: bhDesk })).status).toBe(200);
  });

  it('resolves the DST gap, the repeated hour and a weekend across a transition as node does', () => {
    expect(new Date(instantOf('Europe/Stockholm', Date.UTC(2026, 2, 29, 2, 30))).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(instantOf('Europe/Stockholm', Date.UTC(2026, 9, 25, 2, 30))).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(addBusinessMs(hours, '2026-03-27T15:00:00.000Z', 2 * HOUR)).toBe('2026-03-30T08:00:00.000Z');
    expect(addBusinessMs(hours, '2026-10-23T14:00:00.000Z', 2 * HOUR)).toBe('2026-10-26T09:00:00.000Z');
  });

  it('an arriving conversation is stamped four business hours out, on the DO', async () => {
    const relay = await host().getScope(await relayOf(bhDesk), t, bhDesk);
    const arrived = await relay.invoke<{ conversation_id: string }>('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: 'hours@customer.example',
      contactName: 'Hours',
      subject: 'When are you open?',
      bodyText: 'Asking for a friend.',
      emailMessageId: `<hours-${(arrivals += 1)}@mail.example>`,
    });
    const row = await (await host().getScope(owner, t, bhDesk)).invoke<{
      created_at: string;
      first_response_due_at: string;
    }>('ticket0/get-conversation', { conversationId: arrived.conversation_id });
    // The real clock here (`clock?: never`), so the claim is the relation, not an instant:
    // exactly four hours of opening time lie between arrival and due.
    expect(row.first_response_due_at).toBe(addBusinessMs(hours, row.created_at, 4 * HOUR));
    expect(businessMsBetween(hours, row.created_at, row.first_response_due_at)).toBe(4 * HOUR);
  });
});

/**
 * The issuer, as a suite answers it: each expected request is answered once (or every time,
 * `persist`), and any other egress throws — net-connect disabled. The worker runs in the test's
 * isolate, so stubbing the global is stubbing its egress.
 */
function stubIssuer() {
  type Reply = (request: Request) => Response | Promise<Response>;
  const routes: { method: string; url: string; reply: Reply; persist: boolean }[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const at = routes.findIndex((r) => r.method === request.method && r.url === request.url);
    if (at < 0) throw new Error(`unexpected egress: ${request.method} ${request.url}`);
    const route = routes[at]!;
    if (!route.persist) routes.splice(at, 1);
    return route.reply(request);
  });
  return {
    expect: (method: string, url: string, reply: Reply, persist = false) => routes.push({ method, url, reply, persist }),
    /** The once-only requests not yet made. */
    pending: () => routes.filter((r) => !r.persist).map((r) => `${r.method} ${r.url}`),
    restore: () => spy.mockRestore(),
  };
}

/**
 * #1670 on the runtime a hosted desk runs: the platform's reconcile repairs the desk's entries
 * in a login's PLACES at the identity pool it signs in with. `onProvision` runs on
 * `/internal/reconcile`, and it sends the WHOLE set of subjects bound in the desk's directory
 * (the per-tenant `IdentityDO`), so an addition or a removal whose own report was lost is right
 * again after the next promote. The pool's half — what it keeps of such a report and why no one
 * else's list can be written — is pinned in `demos/auth-server/test/workerd/reconcile.test.ts`.
 *
 * The issuer is `stubIssuer`: it answers where to report, and records the report.
 */
describe("ticket0 on workerd — a reconcile repairs the desk's places at its identity pool (#1670)", () => {
  const tenant = tenantId.parse(ulid());
  const desk = scopeId.parse(ulid());
  const ISSUER = 'https://auth.places.test';
  const directory = () => env.AUTH.get(env.AUTH.idFromName(tenant));

  let issuer: ReturnType<typeof stubIssuer>;
  beforeAll(() => {
    issuer = stubIssuer();
  });
  afterAll(() => issuer.restore());

  /** The next report the issuer receives, captured. */
  function nextReport(): { body: () => unknown } {
    let captured: unknown;
    issuer.expect('POST', `${ISSUER}/api/places/report`, async (request) => {
      captured = await request.json();
      return new Response(null, { status: 204 });
    });
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

    issuer.expect('GET', `${ISSUER}/.well-known/substrat-places`, () =>
      Response.json({ report_endpoint: `${ISSUER}/api/places/report` }),
    );
    const first = nextReport();
    const { owner: _owner, ...reconcile } = install;
    expect((await platform('/internal/reconcile', reconcile)).status).toBe(200);
    expect(issuer.pending()).toEqual([]);
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
    expect(issuer.pending()).toEqual([]);
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
 * Signed in with a bearer the test signs itself, against a `stubIssuer` issuer: the route
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
  let issuer: ReturnType<typeof stubIssuer>;

  const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  const encodeJson = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

  /** A bearer the issuer signed for `sub`, valid for `ttlSec`. */
  async function bearerFor(sub: string, ttlSec = 300): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const head = `${encodeJson({ alg: 'RS256', kid: 'live-1', typ: 'JWT' })}.${encodeJson({
      iss: ISSUER,
      sub,
      iat: now,
      exp: now + ttlSec,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(head));
    return `${head}.${b64url(signature)}`;
  }

  /** The handshake, as the router forwards a browser's. */
  function handshake(headers: Record<string, string>, path = '/api/live'): Promise<Response> {
    return SELF.fetch(`${ORIGIN}${path}`, {
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

    issuer = stubIssuer();
    issuer.expect(
      'GET',
      `${ISSUER}/.well-known/openid-configuration`,
      () => Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, authorization_endpoint: `${ISSUER}/authorize` }),
      true,
    );
    issuer.expect('GET', `${ISSUER}/jwks`, () => Response.json({ keys: [{ ...jwk, alg: 'RS256', kid: 'live-1', use: 'sig' }] }), true);

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
  afterAll(() => issuer.restore());

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

  it('does not announce a moved message to the losing thread\'s follower after a merge (#1858)', async () => {
    await member('sub-merge-agent', 'agent');
    const follower = await member('sub-merge-follower', 'customer');
    const loser = await arrival('merge@live.example');
    const survivor = await arrival('merge@live.example');
    await grant(follower, 'conversation:read', 'conversation', loser.conversation);
    const admin = await host().getScope(deskOwner, tenant, desk);
    const before = await admin.invoke<Page<{ id: string }>>('ticket0/list-messages', {
      conversationId: loser.conversation,
    });
    const movedId = before.entries[0]!.id;

    const followerFeed = await subscribe('sub-merge-follower');
    const agentFeed = await subscribe('sub-merge-agent');
    await admin.invoke('ticket0/merge', {
      conversationId: loser.conversation,
      intoConversationId: survivor.conversation,
    });
    const relay = await host().getScope((await services()).relay, tenant, desk);
    await relay.invoke('ticket0/record-delivery', { messageId: movedId, emailMessageId: '<merged-delivered@mail.example>' });
    await settle();

    const delivered = (feed: { frames: LiveChange[] }) => feed.frames.filter((f) => f.type === 'ticket0.message-delivered').map((f) => f.entityId);
    expect(followerFeed.frames.map((f) => f.entityId)).not.toContain(movedId);
    expect(delivered(followerFeed)).not.toContain(movedId);
    expect(delivered(agentFeed)).toContain(movedId);
    await expect(
      (await host().getScope(follower, tenant, desk)).invoke('ticket0/list-messages', {
        conversationId: survivor.conversation,
      }),
    ).rejects.toThrow(/permission denied/i);
    const polled = await admin.invoke<Page<{ id: string }>>('ticket0/list-messages', {
      conversationId: survivor.conversation,
    });
    expect(polled.entries.map((m) => m.id)).toContain(movedId);
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

  // -- the portal's feed: one conversation, as its customer may see it (#938) --------

  const portalHandshake = async (sub: string, conversationId: string, ttlSec?: number) =>
    handshake(
      { origin: ORIGIN, authorization: `Bearer ${await bearerFor(sub, ttlSec)}` },
      `/api/conversations/${conversationId}/live`,
    );

  /** A customer's socket on one conversation's portal feed, its frames, and how the scope closed it. */
  async function subscribePortal(
    sub: string,
    conversationId: string,
    ttlSec?: number,
  ): Promise<{ frames: LiveFrame[]; closedWith: number | null }> {
    const response = await portalHandshake(sub, conversationId, ttlSec);
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    open.push(ws);
    const feed = { frames: [] as LiveFrame[], closedWith: null as number | null };
    ws.addEventListener('message', (event) => {
      const data = String((event as MessageEvent).data);
      if (data !== 'pong') feed.frames.push(JSON.parse(data) as LiveFrame);
    });
    ws.addEventListener('close', (event) => {
      feed.closedWith = (event as CloseEvent).code;
    });
    return feed;
  }

  const reply = async (conversationId: string, body: string) =>
    (await host().getScope(deskOwner, tenant, desk)).invoke<{ id: string }>('ticket0/post-public-reply', {
      conversationId,
      body,
    });

  it("nudges a portal customer about a public reply on their thread, and about nothing else on it", async () => {
    const customer = await member('sub-portal', 'customer');
    const theirs = await arrival('portal@live.example');
    await grant(customer, 'conversation:read-own', 'contact', theirs.contact);
    const feed = await subscribePortal('sub-portal', theirs.conversation);

    await note(theirs.conversation, 'Internal: check their plan first.');
    await settle();
    // The negative first: a note on their own thread sends nothing at all.
    expect(feed.frames).toEqual([]);

    const answered = await reply(theirs.conversation, 'We are on it.');
    await settle();
    expect(feed.frames.length).toBeGreaterThan(0);
    // A nudge names nothing: the customer re-reads `my-messages`, which is what shows it.
    for (const frame of feed.frames) expect(Object.keys(frame).sort()).toEqual(['at', 'id', 'kind']);
    expect(feed.frames.every((f) => f.kind === 'nudge')).toBe(true);
    const polled = await (await host().getScope(customer, tenant, desk)).invoke<Page<{ id: string }>>(
      'ticket0/my-messages',
      { conversationId: theirs.conversation },
    );
    expect(polled.entries.map((m) => m.id)).toContain(answered.id);
    expect(feed.closedWith).toBeNull();
  });

  it("refuses a customer the feed of another contact's conversation, and an agent the portal's", async () => {
    const customer = await member('sub-portal-other', 'customer');
    await member('sub-portal-agent', 'agent');
    const theirs = await arrival('portal-mine@live.example');
    const notTheirs = await arrival('portal-someone@live.example');
    await grant(customer, 'conversation:read-own', 'contact', theirs.contact);

    const refused = await portalHandshake('sub-portal-other', notTheirs.conversation);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-substrat-live')).toBe('forbidden');
    expect(refused.webSocket).toBeNull();
    // Staff read the desk on `/api/live`; the portal's gate is the customer's own key.
    expect((await portalHandshake('sub-portal-agent', theirs.conversation)).status).toBe(403);
    // The positive twin: the same customer, their own conversation.
    const own = await subscribePortal('sub-portal-other', theirs.conversation);
    expect(own.closedWith).toBeNull();
  });

  it('closes a portal socket, unnudged, once the customer’s grant is withdrawn', async () => {
    const customer = await member('sub-portal-revoked', 'customer');
    const theirs = await arrival('portal-revoked@live.example');
    await grant(customer, 'conversation:read-own', 'contact', theirs.contact);
    const feed = await subscribePortal('sub-portal-revoked', theirs.conversation);
    await reply(theirs.conversation, 'First answer.');
    await settle();
    const heard = feed.frames.length;
    expect(heard).toBeGreaterThan(0);

    // Withdrawn the way a portal grant is: the tuple revoked, while the socket stays open.
    const scopeDo = env.SCOPE.get(env.SCOPE.idFromName(desk)) as unknown as {
      revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
    };
    await scopeDo.revokeTuple(
      `principal:${customer}`,
      'granted:conversation:read-own',
      `contact:${theirs.contact}`,
      new Date().toISOString(),
    );
    await reply(theirs.conversation, 'Second answer.');
    await settle();
    expect(feed.frames).toHaveLength(heard);
    expect(feed.closedWith).toBe(1008);
    // And the client's reconnect is refused at the handshake.
    expect((await portalHandshake('sub-portal-revoked', theirs.conversation)).status).toBe(403);
  });

  it('closes a portal socket, unnudged, once the session that opened it has expired, though the grant holds', async () => {
    const customer = await member('sub-portal-expiring', 'customer');
    const theirs = await arrival('portal-expiring@live.example');
    await grant(customer, 'conversation:read-own', 'contact', theirs.contact);
    // A bearer good for two seconds, and its twin good for five minutes, on one thread.
    const expiring = await subscribePortal('sub-portal-expiring', theirs.conversation, 2);
    const current = await subscribePortal('sub-portal-expiring', theirs.conversation);
    await reply(theirs.conversation, 'Before the session ends.');
    await settle();
    const heard = expiring.frames.length;
    expect(heard).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await reply(theirs.conversation, 'After it ended.');
    await settle();
    expect(expiring.frames).toHaveLength(heard);
    expect(expiring.closedWith).toBe(1008);
    // The twin from the same write: the grant still holds, and a current session hears it.
    expect(current.closedWith).toBeNull();
    expect(current.frames.length).toBeGreaterThan(heard);
  });

  it('does not nudge a socket on the losing thread once a merge has moved its messages (#2044)', async () => {
    // A merge joins one contact's conversations (it refuses two contacts'), so one
    // customer watches both: the thread that loses its messages and the one that gains them.
    const customer = await member('sub-portal-merge', 'customer');
    const loser = await arrival('portal-merge@live.example');
    const survivor = await arrival('portal-merge@live.example');
    await grant(customer, 'conversation:read-own', 'contact', loser.contact);
    const admin = await host().getScope(deskOwner, tenant, desk);
    const moved = (
      await admin.invoke<Page<{ id: string }>>('ticket0/list-messages', { conversationId: loser.conversation })
    ).entries[0]!.id;
    const onLoser = await subscribePortal('sub-portal-merge', loser.conversation);
    const onSurvivor = await subscribePortal('sub-portal-merge', survivor.conversation);

    await admin.invoke('ticket0/merge', {
      conversationId: loser.conversation,
      intoConversationId: survivor.conversation,
    });
    await settle();
    const loserHeard = onLoser.frames.length;
    const survivorHeard = onSurvivor.frames.length;

    await reply(survivor.conversation, 'Answered on the survivor.');
    // A write to a message that moved: it now reaches the survivor's thread, not the loser's.
    await (await host().getScope((await services()).relay, tenant, desk)).invoke('ticket0/record-delivery', {
      messageId: moved,
      emailMessageId: '<portal-merged@mail.example>',
    });
    await settle();
    expect(onLoser.frames).toHaveLength(loserHeard);
    // The twin, from the same writes: the thread the messages joined hears them.
    expect(onSurvivor.frames.length).toBeGreaterThan(survivorHeard);
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
/**
 * #1853 through the deployed worker: the widget's own live feed, `GET
 * /widget/sessions/:id/live`, reached the way an embedding page reaches it — routed, from an
 * allowlisted origin, an upgrade carrying the session token and no login at all.
 *
 * The visitor has no principal, so the feed is vouched: the desk proves the token, then the
 * scope walks from each changed row to the visitor's SESSION and nudges if it gets there.
 * What hangs under a session is exactly what `widget-thread` shows the visitor, so every
 * negative below sits beside the write that does nudge:
 *
 *   - an internal note and an assistant draft on the visitor's own conversation send
 *     nothing, and a public reply on it does;
 *   - another visitor's message sends nothing;
 *   - a nudge names nothing — no event type, no entity;
 *   - after a merge, and after a follow-up, the same open socket hears the thread the
 *     visitor now reads, and `widget-thread` still shows them their own words.
 */
describe("ticket0 on workerd — the widget's feed nudges a visitor about their own thread only (#1853)", () => {
  const tenant = tenantId.parse(ulid());
  const desk = scopeId.parse(ulid());
  const deskOwner = principalId.parse(ulid());
  const DESK = 'https://desk.widget-live.test';
  const EMBED = 'https://customer.widget-live.test';
  const routed = { 'x-substrat-tenant': tenant, 'x-substrat-scope': desk, 'x-substrat-router': env.ROUTER_SECRET };
  const directory = () => env.AUTH.get(env.AUTH.idFromName(tenant));
  const scopeStub = () => env.SCOPE.get(env.SCOPE.idFromName(desk));
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));
  const admin = () => host().getScope(deskOwner, tenant, desk);
  /** One of the desk's service accounts, acting, as the worker's provision hook recorded it. */
  async function service(role: 'widget' | 'relay') {
    const recorded = JSON.parse((await directory().getScopeConfig(desk))['ticket0:services']!) as Record<string, string>;
    return host().getScope(principalId.parse(recorded[role]), tenant, desk);
  }

  const open: WebSocket[] = [];
  afterEach(() => {
    for (const ws of open.splice(0)) ws.close(1000, 'test over');
  });

  /** A visitor opens the widget on the embedding page: the route the bubble calls. */
  async function visitor(): Promise<{ sessionId: string; token: string }> {
    const res = await SELF.fetch(`${DESK}/widget/sessions`, {
      method: 'POST',
      headers: { ...routed, origin: EMBED, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { sessionId: string; token: string };
  }

  function handshake(session: { sessionId: string; token: string }, headers: Record<string, string> = {}): Promise<Response> {
    return SELF.fetch(`${DESK}/widget/sessions/${session.sessionId}/live?token=${encodeURIComponent(session.token)}`, {
      headers: {
        ...routed,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        origin: EMBED,
        ...headers,
      },
    });
  }

  async function watch(session: { sessionId: string; token: string }): Promise<{ frames: LiveFrame[] }> {
    const response = await handshake(session);
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    open.push(ws);
    const frames: LiveFrame[] = [];
    ws.addEventListener('message', (event) => {
      const data = String((event as MessageEvent).data);
      if (data !== 'pong') frames.push(JSON.parse(data) as LiveFrame);
    });
    return { frames };
  }

  /** Says something — the operation behind the widget's POST, without the assistant it wakes. */
  const say = async (session: { sessionId: string; token: string }, body: string) =>
    (await service('widget')).invoke<{ id: string; conversation_id: string }>('ticket0/widget-post', { ...session, body });
  const thread = async (session: { sessionId: string; token: string }) =>
    (await (await service('widget')).invoke<Page<{ body_text: string }>>('ticket0/widget-thread', session)).entries.map(
      (m) => m.body_text,
    );

  beforeAll(async () => {
    expect(
      (await platform('/internal/provision', { tenantId: tenant, scopeId: desk, owner: deskOwner, entitlements })).status,
    ).toBe(201);
    await (await admin()).invoke('ticket0/configure-desk', { allowedOrigins: [EMBED] });
  });

  it('nudges about a public reply, and not about a note or a draft on the same thread', async () => {
    const session = await visitor();
    const asked = await say(session, 'Where is my parcel?');
    const feed = await watch(session);
    const desk_ = await admin();

    await desk_.invoke('ticket0/post-note', { conversationId: asked.conversation_id, body: 'Check the courier first.' });
    await desk_.invoke('ticket0/record-answer', {
      conversationId: asked.conversation_id,
      turnId: ulid(),
      model: 'test-model',
      body: 'A draft the desk has not approved.',
      inputTokens: 0,
      outputTokens: 0,
      citedArticleIds: [],
      outcome: 'drafted',
    });
    await settle();
    // Not "no frame naming the note": no frame at all. The note's existence, and its timing,
    // are the desk's.
    expect(feed.frames).toEqual([]);

    await desk_.invoke('ticket0/post-public-reply', { conversationId: asked.conversation_id, body: 'It left today.' });
    await settle();
    expect(feed.frames.length).toBeGreaterThan(0);
    for (const frame of feed.frames) expect(Object.keys(frame).sort()).toEqual(['at', 'id', 'kind']);
    expect(feed.frames.every((f) => f.kind === 'nudge')).toBe(true);
  });

  it("sends nothing about another visitor's thread", async () => {
    const mine = await visitor();
    await say(mine, 'Mine.');
    const feed = await watch(mine);
    const theirs = await visitor();
    await say(theirs, 'Somebody else entirely.');
    await settle();
    expect(feed.frames).toEqual([]);
    // The twin: the same visitor writing again is heard.
    await say(mine, 'Mine, again.');
    await settle();
    expect(feed.frames.length).toBeGreaterThan(0);
  });

  it('opens for a session with no message yet, and hears the first one', async () => {
    const session = await visitor();
    const feed = await watch(session);
    await say(session, 'First words.');
    await settle();
    expect(feed.frames.length).toBeGreaterThan(0);
  });

  it('refuses a wrong token, another origin and a plain GET — before any socket exists', async () => {
    const session = await visitor();
    const wrongToken = await handshake({ ...session, token: 'not-the-token' });
    expect(wrongToken.status).toBe(403);
    expect(wrongToken.webSocket).toBeNull();
    const elsewhere = await handshake(session, { origin: 'https://elsewhere.test' });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.webSocket).toBeNull();
    const plain = await SELF.fetch(`${DESK}/widget/sessions/${session.sessionId}/live?token=${session.token}`, {
      headers: { ...routed, origin: EMBED },
    });
    expect(plain.status).toBe(426);
  });

  it('keeps hearing the thread after its conversation is merged away, on the socket already open', async () => {
    const session = await visitor();
    const asked = await say(session, 'Asked in the chat.');
    // The same person also wrote in by mail. Merging needs one contact on both threads, which
    // an anonymous visitor only gets by being recognised — stood in for here in SQL.
    const relay = await service('relay');
    const mailed = await relay.invoke<{ conversation_id: string }>('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: 'merged@widget-live.test',
      subject: 'Also by mail',
      bodyText: 'Asked by mail.',
      emailMessageId: `<widget-live-${ulid()}@mail.example>`,
    });
    await runInDurableObject(scopeStub(), async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE ticket0_conversations SET contact_id = (SELECT contact_id FROM ticket0_conversations WHERE id = ?) WHERE id = ?`,
        asked.conversation_id,
        mailed.conversation_id,
      );
    });
    const feed = await watch(session);
    const desk_ = await admin();
    await desk_.invoke('ticket0/merge', { conversationId: asked.conversation_id, intoConversationId: mailed.conversation_id });
    await settle();
    const afterMerge = feed.frames.length;

    await desk_.invoke('ticket0/post-note', { conversationId: mailed.conversation_id, body: 'Internal, on the survivor.' });
    await settle();
    expect(feed.frames).toHaveLength(afterMerge);
    await desk_.invoke('ticket0/post-public-reply', { conversationId: mailed.conversation_id, body: 'Answered on the survivor.' });
    await settle();
    expect(feed.frames.length).toBeGreaterThan(afterMerge);
    // And the poll the nudge triggers shows the visitor their own words, and the reply.
    expect(await thread(session)).toEqual(expect.arrayContaining(['Asked in the chat.', 'Answered on the survivor.']));
  });

  it('moves with the session onto a follow-up, and stops hearing the closed thread', async () => {
    const session = await visitor();
    const first = await say(session, 'Before the close.');
    const desk_ = await admin();
    await desk_.invoke('ticket0/close', { conversationId: first.conversation_id });
    const before = await thread(session);
    const feed = await watch(session);
    const next = await say(session, 'After the close.');
    expect(next.conversation_id).not.toBe(first.conversation_id);
    await settle();
    expect(feed.frames.length).toBeGreaterThan(0);
    const heard = feed.frames.length;

    // The closed thread is no longer the visitor's: a delivery recorded on its message sends nothing.
    const relay = await service('relay');
    await relay.invoke('ticket0/record-delivery', { messageId: first.id, emailMessageId: `<closed-${ulid()}@mail.example>` });
    await settle();
    expect(feed.frames).toHaveLength(heard);
    // `widget-thread` reads the session's CURRENT conversation, as it did before the feed
    // existed: what it returned before the follow-up is what this test pins, unchanged.
    expect(before).toEqual(['Before the close.']);
    expect(await thread(session)).toEqual(['After the close.']);
  });

  /** `entity.relinked` rows one operation wrote, and an entity's live parents, in the desk's own storage. */
  const relinksBy = async (operation: string) =>
    runInDurableObject(scopeStub(), async (_instance, state) =>
      Number(
        [
          ...state.storage.sql.exec(
            `SELECT COUNT(*) AS n FROM _substrat_outbox WHERE type = 'entity.relinked' AND operation = ?`,
            operation,
          ),
        ][0]!.n,
      ),
    );
  const liveParents = async (subject: string) =>
    runInDurableObject(scopeStub(), async (_instance, state) =>
      [
        ...state.storage.sql.exec(
          `SELECT object FROM _substrat_tuples WHERE subject = ? AND relation = 'parent' AND revoked_at IS NULL ORDER BY object`,
          subject,
        ),
      ].map((r) => String(r.object)),
    );

  it('moves a long thread off the session with two relinks, and each message holds two edges (#2044)', async () => {
    const session = await visitor();
    const first = await say(session, 'The opening line.');
    const desk_ = await admin();
    const replies: string[] = [];
    for (let i = 0; i < 8; i++) {
      replies.push(
        (await desk_.invoke<{ id: string }>('ticket0/post-public-reply', { conversationId: first.conversation_id, body: `Reply ${i}` })).id,
      );
    }
    for (const id of [first.id, ...replies]) {
      expect(await liveParents(`message:${id}`)).toEqual([`conversation:${first.conversation_id}`, `publicThread:${first.conversation_id}`]);
    }
    await desk_.invoke('ticket0/close', { conversationId: first.conversation_id });
    const before = await relinksBy('ticket0/widget-post');
    const next = await say(session, 'After the close.');
    // The session's own edge and the closed thread coming off it — not one per message.
    expect((await relinksBy('ticket0/widget-post')) - before).toBe(2);
    expect(await liveParents(`publicThread:${first.conversation_id}`)).toEqual([`conversation:${first.conversation_id}`]);
    expect(await liveParents(`publicThread:${next.conversation_id}`)).toEqual(
      [`conversation:${next.conversation_id}`, `widgetSession:${session.sessionId}`].sort(),
    );
  });

  it('a socket re-opened after a merge hears the survivor, and after a move only its own new thread (#2044)', async () => {
    // Two widget chats from one person, merged: both sessions now sit on the survivor.
    const loser = await visitor();
    const lost = await say(loser, 'Asked first.');
    const keeper = await visitor();
    const kept = await say(keeper, 'Asked again.');
    await runInDurableObject(scopeStub(), async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE ticket0_conversations SET contact_id = (SELECT contact_id FROM ticket0_conversations WHERE id = ?) WHERE id = ?`,
        lost.conversation_id,
        kept.conversation_id,
      );
    });
    const desk_ = await admin();
    await desk_.invoke('ticket0/merge', { conversationId: lost.conversation_id, intoConversationId: kept.conversation_id });

    // The loser's browser reconnects — a reload, a dropped socket — after the merge.
    const reopened = await watch(loser);
    const keeperFeed = await watch(keeper);
    await desk_.invoke('ticket0/post-note', { conversationId: kept.conversation_id, body: 'Internal, after the merge.' });
    await settle();
    expect(reopened.frames).toEqual([]);
    expect(keeperFeed.frames).toEqual([]);
    await desk_.invoke('ticket0/post-public-reply', { conversationId: kept.conversation_id, body: 'One answer for both.' });
    await settle();
    expect(reopened.frames.length).toBeGreaterThan(0);
    expect(keeperFeed.frames.length).toBeGreaterThan(0);
    for (const frame of [...reopened.frames, ...keeperFeed.frames]) expect(Object.keys(frame).sort()).toEqual(['at', 'id', 'kind']);
    // A message the merge MOVED is on the survivor's thread too: a write to it reaches the
    // session that was always on the survivor.
    const keeperBefore = keeperFeed.frames.length;
    await (await service('relay')).invoke('ticket0/record-delivery', {
      messageId: lost.id,
      emailMessageId: `<lost-${ulid()}@mail.example>`,
    });
    await settle();
    expect(keeperFeed.frames.length).toBeGreaterThan(keeperBefore);

    // Merge, then a move: the survivor closes, the loser's visitor writes and moves on alone.
    await desk_.invoke('ticket0/close', { conversationId: kept.conversation_id });
    const moved = await say(loser, 'Something new.');
    expect(moved.conversation_id).not.toBe(kept.conversation_id);
    await settle();
    const heardByLoser = reopened.frames.length;
    const heardByKeeper = keeperFeed.frames.length;
    // A reply on the follow-up reaches the moved session only; one on the survivor, the other only.
    await desk_.invoke('ticket0/post-public-reply', { conversationId: moved.conversation_id, body: 'On the follow-up.' });
    await settle();
    expect(reopened.frames.length).toBeGreaterThan(heardByLoser);
    expect(keeperFeed.frames).toHaveLength(heardByKeeper);
    const loserNow = reopened.frames.length;
    await (await service('relay')).invoke('ticket0/record-delivery', {
      messageId: kept.id,
      emailMessageId: `<kept-${ulid()}@mail.example>`,
    });
    await settle();
    expect(reopened.frames).toHaveLength(loserNow);
    // The twin: the session still on the survivor hears that same write.
    expect(keeperFeed.frames.length).toBeGreaterThan(heardByKeeper);
    expect(await thread(loser)).toEqual(['Something new.', 'On the follow-up.']);
  });
});

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
   * Take back every human role, leaving service roles live (#1896). The reconcile
   * must repair the human lockout without revoking or relying on those service seats.
   */
  async function revokeEveryHumanRole(s: ScopeId): Promise<void> {
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
    const serviceRoles = new Set(['relay', 'widget', 'assistant']);
    expect(live.filter(({ role }) => serviceRoles.has(role)).length).toBeGreaterThan(0);
    for (const { who, role } of live.filter(({ role }) => !serviceRoles.has(role))) {
      expect(await host().revokeScopeRole(s, principalId.parse(who), role)).toBe(true);
    }
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

    // The lockout: B revoked too, with every other human role; services stay live. The repair
    // re-seats the RECORD.
    await revokeEveryHumanRole(s);
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
    await revokeEveryHumanRole(s);
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
    await revokeEveryHumanRole(s); // later B too, and with it the desk's last holder
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
    // From the record (B), a fresh hand-over goes through. A keeps the seat it never lost: an
    // abandon revokes nothing, and the next owner removes it in the app.
    expect((await transfer(s, B, C)).status).toBe(200);
    expect(await directory().getOwnerOfRecord(s)).toBe(C);
    expect(await ownerSeats(s)).toEqual([A, C].sort());
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

/**
 * #1083 on the runtime a hosted desk runs: the built-in behaviours' SQL, executed by a
 * Durable Object's SQLite and fired by the deployment's own sweeper.
 *
 * The node suites (`test/automation.test.ts`, `test/off-boarding.test.ts`) hold every
 * behavioural claim. What only a Durable Object can answer is whether the SQL those
 * behaviours run is SQL the DO accepts — a correlated subquery in a join, an upsert, a
 * partial index from one migration — and whether the schedules the manifest declares
 * are wired to the sweeper, since a schedule the host never fires is the failure #1646
 * was. So this drives all three new schedules and the ring through one pass of the real
 * sweeper, and reads the outcome back through the operations the app calls.
 *
 * The DO host has no injectable clock, so a wait is aged in the rows themselves.
 */
describe('ticket0 on workerd — the built-in behaviours run on a Durable Object (#1083)', () => {
  const behaviours = scopeId.parse(ulid());
  const stub = () => env.SCOPE.get(env.SCOPE.idFromName(behaviours));
  const LONG_AGO = '2020-01-01T00:00:00.000Z';

  let owner_: Awaited<ReturnType<CloudflareScopeHost['getScope']>>;
  let relay_: Awaited<ReturnType<CloudflareScopeHost['getScope']>>;

  beforeAll(async () => {
    expect((await platform('/internal/provision', { tenantId: t, scopeId: behaviours, owner, entitlements })).status).toBe(201);
    owner_ = await host().getScope(owner, t, behaviours);
    relay_ = await host().getScope(await relayOf(behaviours), t, behaviours);
    // The owner is on the desk: a profile is what puts anybody in the ring and the broadcast.
    await owner_.invoke('ticket0/set-agent-profile', { displayName: 'Owner', avatarUrl: null, signature: null });
  });

  afterAll(async () => {
    expect((await platform('/internal/delete-scope', { scopeId: behaviours })).status).toBe(200);
  });

  async function mail(subject: string, body: string): Promise<string> {
    const arrived = await relay_.invoke<{ conversation_id: string }>('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: `customer-${(arrivals += 1)}@customer.example`,
      contactName: null,
      subject,
      bodyText: body,
      emailMessageId: `<behaviour-${arrivals}@mail.example>`,
    });
    return arrived.conversation_id;
  }

  const sql = (statement: string, ...bindings: (string | number)[]) =>
    runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec(statement, ...bindings);
    });

  it('the migration built its indexes and its table on the DO', async () => {
    const names = await runInDurableObject(stub(), (_i, state) =>
      [
        ...state.storage.sql.exec(
          `SELECT name FROM sqlite_master
            WHERE name IN ('ticket0_conversations_untagged', 'ticket0_conversations_no_reply_candidate', 'ticket0_behaviour_runs')
            ORDER BY name`,
        ),
      ].map((r) => String(r.name)),
    );
    expect(names).toEqual(['ticket0_behaviour_runs', 'ticket0_conversations_no_reply_candidate', 'ticket0_conversations_untagged']);
  });

  it('one sweeper pass tags, closes and announces — and stamps when each last fired', async () => {
    await owner_.invoke('ticket0/configure-desk', {
      settings: {
        autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] },
        autoClose: { afterDays: 1 },
        noReplyNotify: { afterHours: 1 },
      },
    });

    const tagged = await mail('REFUND for order 12', 'Charged twice.');
    const waiting = await mail('Where is my export?', 'Waiting on this.');
    const finished = await mail('All sorted', 'Thanks.');
    await owner_.invoke('ticket0/post-public-reply', { conversationId: finished, body: 'Done.' });
    await owner_.invoke('ticket0/resolve', { conversationId: finished });
    // Age what the windows measure: the customer's message, and the resolved conversation.
    await sql('UPDATE ticket0_messages SET created_at = ? WHERE conversation_id = ?', LONG_AGO, waiting);
    await sql('UPDATE ticket0_conversations SET no_reply_waiting_since = ?, no_reply_candidate_at = ? WHERE id = ?',
      LONG_AGO, LONG_AGO, waiting);
    await sql('UPDATE ticket0_conversations SET updated_at = ? WHERE id = ?', LONG_AGO, finished);

    const report = await sweep();
    expect(report.errors).toEqual([]);
    expect(report.schedules.failed).toBe(0);

    const tags = await owner_.invoke<{ tags: { tag: string }[] }>('ticket0/list-conversation-tags', {
      conversationId: tagged,
    });
    expect(tags.tags.map((x) => x.tag)).toEqual(['billing']);
    expect((await conversation(behaviours, finished)).state).toBe('closed');

    const notices = await owner_.invoke<Page<{ kind: string; conversation_id: string | null }>>(
      'ticket0/my-notifications',
      {},
    );
    expect(notices.entries.filter((n) => n.kind === 'escalated' && n.conversation_id === waiting)).toHaveLength(1);

    const runs = await owner_.invoke<{ runs: { behaviour: string; last_count: number }[] }>(
      'ticket0/list-behaviour-runs',
      {},
    );
    expect(runs.runs.map((r) => r.behaviour)).toEqual(['autoClose', 'autoTag', 'noReplyNotify']);
  });

  it('the ring skips an off-boarded agent on the DO, and hands work once they are back', async () => {
    await owner_.invoke('ticket0/configure-desk', { settings: { roundRobin: true } });
    await owner_.invoke('ticket0/set-agent-offboarded', { principal: owner, offboarded: true });
    // The desk's own principal, as the sweeper runs the schedule: a schedule is due once per
    // cadence, so the ring is invoked directly rather than waited for.
    const ring = async () =>
      (await (await host().getSystemScope(moduleId.parse(ticket0Manifest.id), t, behaviours)).invoke<{
        assigned: number;
      }>('ticket0/assign-round-robin')).assigned;

    const first = await mail('Nobody home', 'Anyone?');
    expect(await ring()).toBe(0);
    expect((await conversation(behaviours, first)) as Conversation & { assignee: string | null }).toMatchObject({
      assignee: null,
    });
    await expect(
      owner_.invoke('ticket0/assign', { conversationId: first, assignee: owner }),
    ).rejects.toThrow(/not on this desk any more/);

    await owner_.invoke('ticket0/set-agent-offboarded', { principal: owner, offboarded: false });
    // The two conversations the previous case left unassigned are the backlog, and go with it.
    expect(await ring()).toBe(3);
    expect(
      (await conversation(behaviours, first)) as Conversation & { assignee: string | null },
    ).toMatchObject({ assignee: owner });
  });
});

/**
 * #1088 on the runtime a hosted desk runs. Node's SQLite is not a Durable Object's, so the
 * spam filter's reads (`lower(trim(…))`, `COUNT(DISTINCT …)` over a join), the kernel walk's
 * new `IS NULL` filter, the bulk discard's deletes and migration 0021 itself are run here
 * against the real thing. The last case is the migration on a LARGE desk — tens of thousands
 * of conversations with messages, tags and follows — timed, because 0021 rebuilds every
 * conversation index the kernel derives and a migration runs inside the first request a
 * desk serves after the deploy.
 */
describe('ticket0 on workerd — the suspended queue and the spam filter (#1088)', () => {
  const spamDesk = scopeId.parse(ulid());
  const stub = () => env.SCOPE.get(env.SCOPE.idFromName(spamDesk));
  const LINKS = 'Deals https://a.example/1 https://b.example/2 https://c.example/3';
  const PITCH = 'Buy followers cheap, fast delivery guaranteed';
  let mails = 0;

  beforeAll(async () => {
    expect((await platform('/internal/provision', { tenantId: t, scopeId: spamDesk, owner, entitlements })).status).toBe(201);
    await (await host().getScope(owner, t, spamDesk)).invoke('ticket0/configure-desk', { settings: { spamFilter: {} } });
  });

  afterAll(async () => {
    expect((await platform('/internal/delete-scope', { scopeId: spamDesk })).status).toBe(200);
  });

  async function mail(from: string, bodyText: string): Promise<string> {
    const relay = await host().getScope(await relayOf(spamDesk), t, spamDesk);
    const arrived = await relay.invoke<{ conversation_id: string }>('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: from,
      contactName: null,
      subject: `Mail ${(mails += 1)}`,
      bodyText,
      emailMessageId: `<spam-${mails}@mail.example>`,
    });
    return arrived.conversation_id;
  }

  it('holds links and a pasted run, lists the inbox without them, and discards in bulk', async () => {
    const admin = await host().getScope(owner, t, spamDesk);
    const linked = await mail('one@junk.example', LINKS);
    const plain = await mail('two@customer.example', 'How do I rotate a key?');
    await mail('three@junk.example', PITCH);
    await mail('four@junk.example', `  ${PITCH.toUpperCase()} `);
    const run = await mail('five@junk.example', PITCH);

    // The kernel walk's `quarantine IS NULL`, on the DO: the plain mail and the run's
    // first two copies, and neither held one.
    const inbox = (await admin.invoke<Page<{ id: string }>>('ticket0/list-conversations', { limit: 50 })).entries.map(
      (c) => c.id,
    );
    expect(inbox).toHaveLength(3);
    expect(inbox).toContain(plain);
    expect(inbox).not.toContain(linked);
    expect(inbox).not.toContain(run);

    const queue = await admin.invoke<Page<{ id: string; reasons: string[] }>>('ticket0/list-suspended', { limit: 50 });
    expect(Object.fromEntries(queue.entries.map((r) => [r.id, r.reasons]))).toEqual({
      [linked]: ['links'],
      [run]: ['repeated'],
    });

    const done = await admin.invoke<{ discarded: string[] }>('ticket0/discard-suspended', { conversationIds: [linked, run] });
    expect(done.discarded).toEqual([linked, run]);
    const left = await runInDurableObject(stub(), (_i, state) => [
      ...state.storage.sql.exec(
        `SELECT COUNT(*) AS n FROM ticket0_messages WHERE conversation_id IN (?, ?)`,
        linked,
        run,
      ),
    ]);
    expect(left).toEqual([{ n: 0 }]);
  });

  it('the migration narrowed every live-work index on the DO to the inbox', async () => {
    const sql = await runInDurableObject(stub(), (_i, state) =>
      Object.fromEntries(
        [
          ...state.storage.sql.exec(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ticket0_conversations' AND name LIKE 'ticket0_%'",
          ),
        ].map((r) => [String(r.name), String(r.sql)]),
      ),
    );
    for (const name of INBOX_PARTIAL_INDEXES) {
      expect(sql[name], name).toMatch(/AND quarantine IS NULL$/);
    }
    expect(sql['ticket0_conversations_suspended']).toMatch(/WHERE quarantine = 'suspended'$/);
  });

  it('0021 on a large desk: every row stays in the inbox, and the time it takes is measured', async () => {
    const CONVERSATIONS = 30_000;
    const lists = MODULES.find((m) => m.manifest.id === ticket0Manifest.id)!.manifest.lists ?? [];
    // Both sides before 0027 (#1087), which moved the saved-reply lists: this is 0021's step.
    const before = listIndexMigrations(ticket0Manifest.id, listsBefore0021(listsBefore0027(lists)));
    const now = listIndexMigrations(ticket0Manifest.id, listsBefore0027(lists));
    const changed = now.filter((m) => !before.some((b) => b.version === m.version));
    // Exactly the conversation list re-applies: the one declaration 0021 changed.
    expect(changed.map((m) => m.version)).toEqual([expect.stringMatching(/^list\/conversation:/)]);

    const probe = env.SCOPE.get(env.SCOPE.idFromName(`migration-0021-${ulid()}`));
    const timing = await runInDurableObject(probe, async (_i, state) => {
      const sql = state.storage.sql;
      // The schema a desk held before this change. 0020 is a spine repair (it rewrites
      // `_substrat_tuples`, which this bare probe has none of) and changes no ticket0 table.
      for (const m of ticket0Migrations.filter((x) => x.version < '0020')) sql.exec(m.sql);
      for (const m of before) sql.exec(m.sql);
      state.storage.transactionSync(() => {
        sql.exec("INSERT INTO ticket0_contacts (id, created_at) VALUES ('k', '2026-01-01T00:00:00.000Z')");
        for (let i = 0; i < CONVERSATIONS; i++) {
          const id = `c${String(i).padStart(6, '0')}`;
          const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
          sql.exec(
            `INSERT INTO ticket0_conversations (id, contact_id, channel, subject, state, priority, created_at, updated_at,
               first_response_due_at, no_reply_candidate_at)
             VALUES (?, 'k', 'email', 'Before', ?, 'normal', ?, ?, ?, ?)`,
            id, ['new', 'open', 'snoozed', 'resolved', 'closed'][i % 5]!, at, at, at, i % 3 === 0 ? at : null,
          );
          for (let j = 0; j < 3; j++) {
            sql.exec(
              `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, created_at)
               VALUES (?, ?, 'contact', 'public', 'A customer message of an ordinary length.', ?)`,
              `${id}-${j}`, id, at,
            );
          }
          if (i % 3 === 0) sql.exec('INSERT INTO ticket0_conversation_tags (conversation_id, tag, created_at) VALUES (?, ?, ?)', id, 'billing', at);
          if (i % 15 === 0) sql.exec('INSERT INTO ticket0_conversation_follows (principal, conversation_id) VALUES (?, ?)', 'p', id);
        }
      });
      const started = performance.now();
      state.storage.transactionSync(() => {
        sql.exec(ticket0Migrations.find((m) => m.version === '0021')!.sql);
        for (const m of changed) sql.exec(m.sql);
      });
      const ms = performance.now() - started;
      const rows = [...sql.exec('SELECT COUNT(*) AS n, SUM(quarantine IS NULL) AS inbox FROM ticket0_conversations')][0];
      return { ms, rows };
    });
    expect(timing.rows).toEqual({ n: CONVERSATIONS, inbox: CONVERSATIONS });
    // Reported for the PR rather than asserted tightly: the runtime here is a laptop's
    // workerd. The bound is the DO's default CPU limit for one request, 30 s.
    console.log(`#1088 migration 0021 on ${CONVERSATIONS} conversations: ${Math.round(timing.ms)} ms`);
    expect(timing.ms).toBeLessThan(30_000);
  }, 120_000);
});

/**
 * #1086 on the runtime a hosted desk runs. The participant reads and writes are new SQL —
 * a `DELETE … AS k` with correlated `NOT EXISTS`, the relay's `EXISTS` over participants, a
 * `json_each` page of CCs — and migration 0022 rebuilds the whole message table, which on a
 * Durable Object runs inside the first request a desk serves after the deploy. Both are run
 * here against the real thing; the rebuild on a LARGE desk, timed.
 */
describe('ticket0 on workerd — participants, forwards and migration 0022 (#1086)', () => {
  const ccDesk = scopeId.parse(ulid());
  let mails = 0;

  beforeAll(async () => {
    expect((await platform('/internal/provision', { tenantId: t, scopeId: ccDesk, owner, entitlements })).status).toBe(201);
    await (await host().getScope(owner, t, ccDesk)).invoke('ticket0/configure-desk', { settings: { spamFilter: { maxLinks: 0 } } });
  });

  afterAll(async () => {
    expect((await platform('/internal/delete-scope', { scopeId: ccDesk })).status).toBe(200);
  });

  async function mail(input: Record<string, unknown>): Promise<{ id: string; conversation_id: string; visibility: string }> {
    const relay = await host().getScope(await relayOf(ccDesk), t, ccDesk);
    mails += 1;
    return relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactName: null,
      subject: `Participants ${mails}`,
      bodyText: 'A question.',
      emailMessageId: `<participants-${mails}@mail.example>`,
      ...input,
    });
  }

  it('copies in, forwards, takes the answer as forward, and discards junk with the contacts it brought', async () => {
    const admin = await host().getScope(owner, t, ccDesk);
    const relay = await host().getScope(await relayOf(ccDesk), t, ccDesk);
    const first = await mail({ contactEmail: 'ana@customer.example', cc: ['bo@customer.example', 'support@example.com'] });
    const reply = await admin.invoke<{ id: string }>('ticket0/post-public-reply', {
      conversationId: first.conversation_id,
      body: 'On it.',
    });
    expect(await relay.invoke('ticket0/read-outbound', { messageId: reply.id })).toMatchObject({
      toEmail: 'ana@customer.example',
      ccEmails: ['bo@customer.example'],
    });

    const sent = await admin.invoke<{ id: string }>('ticket0/forward-message', {
      conversationId: first.conversation_id,
      to: 'supplier@vendor.example',
      body: 'In stock?',
    });
    const pendingIds = (await relay.invoke<Page<{ messageId: string }>>('ticket0/list-pending-outbound', { limit: 50 })).entries.map(
      (r) => r.messageId,
    );
    expect(pendingIds).toEqual(expect.arrayContaining([reply.id, sent.id]));
    await relay.invoke('ticket0/record-delivery', { messageId: sent.id, emailMessageId: '<fw@desk.example>' });
    const answer = await mail({ contactEmail: 'supplier@vendor.example', emailInReplyTo: '<fw@desk.example>' });
    expect(answer).toMatchObject({ conversation_id: first.conversation_id, visibility: 'forward' });

    const junk = await mail({
      contactEmail: 'spammer@junk.example',
      bodyText: 'Visit https://junk.example',
      cc: ['victim@target.example', 'ana@customer.example'],
    });
    await admin.invoke('ticket0/discard', { conversationId: junk.conversation_id });
    const left = await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(ccDesk)), (_i, state) =>
      [...state.storage.sql.exec("SELECT email FROM ticket0_contacts WHERE email IN ('victim@target.example', 'ana@customer.example')")].map(
        (r) => r.email,
      ),
    );
    expect(left).toEqual(['ana@customer.example']);
  });

  it('0022 on a large desk: every message kept and named, every index back, and the time it takes is measured', async () => {
    const CONVERSATIONS = 20_000;
    const lists = MODULES.find((m) => m.manifest.id === ticket0Manifest.id)!.manifest.lists ?? [];
    const probe = env.SCOPE.get(env.SCOPE.idFromName(`migration-0022-${ulid()}`));
    const result = await runInDurableObject(probe, async (_i, state) => {
      const sql = state.storage.sql;
      // The schema a desk held before this change. 0020 is a spine repair this bare probe
      // has no spine for, and changes no ticket0 table.
      for (const m of ticket0Migrations.filter((x) => x.version < '0022' && x.version !== '0020')) sql.exec(m.sql);
      for (const m of listIndexMigrations(ticket0Manifest.id, listsBefore0027(lists))) sql.exec(m.sql);
      const indexesOf = () =>
        [...sql.exec("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ticket0_messages' ORDER BY name")].map(
          (r) => `${String(r.name)}: ${String(r.sql)}`,
        );
      const before = indexesOf();
      state.storage.transactionSync(() => {
        sql.exec("INSERT INTO ticket0_contacts (id, created_at) VALUES ('k', '2026-01-01T00:00:00.000Z')");
        for (let i = 0; i < CONVERSATIONS; i++) {
          const id = `c${String(i).padStart(6, '0')}`;
          const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
          sql.exec(
            `INSERT INTO ticket0_conversations (id, contact_id, channel, subject, state, priority, created_at, updated_at)
             VALUES (?, 'k', 'email', 'Before', 'open', 'normal', ?, ?)`,
            id, at, at,
          );
          for (let j = 0; j < 4; j++) {
            sql.exec(
              `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, created_at)
               VALUES (?, ?, ?, ?, 'A message of an ordinary length, the kind a customer writes.', ?)`,
              `${id}-${j}`, id, j % 2 === 0 ? 'contact' : 'agent', j === 3 ? 'internal' : 'public', at,
            );
          }
        }
      });
      const started = performance.now();
      state.storage.transactionSync(() => {
        sql.exec(ticket0Migrations.find((m) => m.version === '0022')!.sql);
      });
      const ms = performance.now() - started;
      const after = indexesOf();
      const counts = [
        ...sql.exec(
          `SELECT COUNT(*) AS n, SUM(author_contact_id = 'k') AS named, SUM(author_kind = 'contact') AS contact
             FROM ticket0_messages`,
        ),
      ][0];
      return { ms, before, after, counts };
    });
    expect(result.counts).toEqual({ n: CONVERSATIONS * 4, named: CONVERSATIONS * 2, contact: CONVERSATIONS * 2 });
    // Every index the table had is back, as it was; the two new ones are the only additions.
    expect(result.after.filter((i) => !/by_author_contact|by_third_party/.test(i))).toEqual(result.before);
    expect(result.after).toHaveLength(result.before.length + 2);
    // Reported for the PR rather than asserted tightly: the runtime here is a laptop's
    // workerd. The bound is the DO's default CPU limit for one request, 30 s.
    console.log(`#1086 migration 0022 on ${CONVERSATIONS * 4} messages: ${Math.round(result.ms)} ms`);
    expect(result.ms).toBeLessThan(30_000);
  }, 120_000);
});

/**
 * #1554's second index pass (0023) on the runtime a hosted desk runs. The node suite
 * (`desk-read-indexes.test.ts`) holds each shape to what the handlers send and to its index on
 * node's SQLite; this runs the same shapes against a Durable Object's, on a large desk upgraded
 * from 0022, and reports what the migration costs: the time it takes inside the first request
 * after a deploy, and the write cost of the hottest table it indexes.
 */
describe('ticket0 on workerd — migration 0023 and the desk reads it indexes (#1554)', () => {
  it('0023 on a large desk: every row kept, every read seeks its index, the pages unmoved, and the cost measured', async () => {
    const CONVERSATIONS = 30_000;
    const WRITES = 2_000;
    const lists = MODULES.find((m) => m.manifest.id === ticket0Manifest.id)!.manifest.lists ?? [];
    const probe = env.SCOPE.get(env.SCOPE.idFromName(`migration-0023-${ulid()}`));
    const result = await runInDurableObject(probe, async (_i, state) => {
      const sql = state.storage.sql;
      // The schema a desk held before this change. 0020 is a spine repair this bare probe has
      // no spine for, and changes no ticket0 table.
      for (const m of ticket0Migrations.filter((x) => x.version < '0023' && x.version !== '0020')) sql.exec(m.sql);
      for (const m of listIndexMigrations(ticket0Manifest.id, listsBefore0027(lists))) sql.exec(m.sql);
      state.storage.transactionSync(() => populateDesk((statement, ...args) => void sql.exec(statement, ...args), CONVERSATIONS));

      const plan = (shape: Shape) => [...sql.exec(`EXPLAIN QUERY PLAN ${shape.sql}`, ...shape.args)].map((r) => String(r.detail));
      const counts = () =>
        Object.fromEntries(DESK_TABLES.map((table) => [table, [...sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)][0]!.n]));
      /** The one error the probe throws on purpose, to roll its rows back. */
      class RollBack extends Error {}
      /**
       * The hottest table this indexes, by rows written: a notification per recipient per event.
       * Rolled back, so the desk is measured as it was. Microseconds per row.
       */
      const writeCost = () => {
        let written = -1;
        let ms = 0;
        try {
          state.storage.transactionSync(() => {
            const started = performance.now();
            for (let n = 0; n < WRITES; n++) {
              sql.exec(
                `INSERT INTO ticket0_notifications (id, principal, kind, conversation_id, created_at) VALUES (?, ?, 'assigned', ?, ?)`,
                `w-${n}`, `agent-${n % 4}`, `c${String(n * 7).padStart(6, '0')}`, '2027-01-01T00:00:00.000Z',
              );
            }
            ms = performance.now() - started;
            // Counted before the rollback, off the clock: a rate over writes that did not happen
            // is no rate. A primary-key range, so the count costs a seek, not a scan.
            written = Number([...sql.exec("SELECT COUNT(*) AS n FROM ticket0_notifications WHERE id >= 'w-' AND id < 'w.'")][0]!.n);
            throw new RollBack();
          });
        } catch (error) {
          // Only the rollback is expected; a failed INSERT fails the test.
          if (!(error instanceof RollBack)) throw error;
        }
        return { written, us: (ms * 1000) / WRITES };
      };

      const snapshot = () => ({ counts: counts(), pages: Object.values(INBOX_PAGES).map(plan), write: writeCost() });
      const before = snapshot();
      const started = performance.now();
      state.storage.transactionSync(() => {
        sql.exec(ticket0Migrations.find((m) => m.version === '0023')!.sql);
      });
      const ms = performance.now() - started;
      return {
        ms,
        before,
        after: snapshot(),
        reads: Object.entries(DESK_READS).map(([name, read]) => ({ name, verdict: planUsesIndex(read, plan(read)) })),
        suspended: plan(SUSPENDED_QUEUE),
      };
    });
    // Every probe write happened before its rollback, and none of them stayed.
    expect([result.before.write.written, result.after.write.written]).toEqual([WRITES, WRITES]);
    expect(result.after.counts).toEqual(result.before.counts);
    expect(result.after.counts['ticket0_conversations']).toBe(CONVERSATIONS);
    // Every shape seeks its index on the DO's SQLite, as on node's.
    expect(result.reads.filter((r) => r.verdict !== null)).toEqual([]);
    expect(result.after.pages).toEqual(result.before.pages);
    expect(result.suspended).toContainEqual(expect.stringMatching(/USING INDEX ticket0_conversations_suspended\b/));
    expect(sorts(result.suspended)).toBe(false);
    // Reported for the PR rather than asserted tightly: the runtime here is a laptop's workerd.
    // The bound is the DO's default CPU limit for one request, 30 s.
    console.log(
      `#1554 migration 0023 on ${CONVERSATIONS} conversations: ${Math.round(result.ms)} ms; ` +
        `notification insert ${result.before.write.us.toFixed(1)} µs/row before, ${result.after.write.us.toFixed(1)} µs/row after`,
    );
    expect(result.ms).toBeLessThan(30_000);
  }, 240_000);
});

/**
 * #1087's rebuild of `ticket0_saved_replies` (0027) on the runtime a hosted desk runs: a table
 * dropped and renamed onto, inside a Durable Object, with the kernel's list indexes of the old
 * declaration on it. The node suite (`saved-replies.test.ts`) holds the upgrade to a fresh
 * desk's schema; this holds the same SQL to the DO's SQLite.
 */
describe('ticket0 on workerd — migration 0027, saved replies keyed per owner (#1087)', () => {
  it('keeps every reply as the desk’s own, drops the old list indexes with the table, and keys titles per owner', async () => {
    const lists = MODULES.find((m) => m.manifest.id === ticket0Manifest.id)!.manifest.lists ?? [];
    const probe = env.SCOPE.get(env.SCOPE.idFromName(`migration-0027-${ulid()}`));
    const result = await runInDurableObject(probe, async (_i, state) => {
      const sql = state.storage.sql;
      // The schema a desk held before this change. 0020 is a spine repair this bare probe has
      // no spine for, and changes no ticket0 table.
      for (const m of ticket0Migrations.filter((x) => x.version < '0027' && x.version !== '0020')) sql.exec(m.sql);
      for (const m of listIndexMigrations(ticket0Manifest.id, listsBefore0027(lists))) sql.exec(m.sql);
      const insert = (id: string, title: string, actions: string | null) =>
        sql.exec(
          `INSERT INTO ticket0_saved_replies (id, title, body, created_by, created_at, actions)
           VALUES (?, ?, 'Body', 'agent-1', '2026-01-01T00:00:00.000Z', ?)`,
          id, title, actions,
        );
      insert('r1', 'Refund', null);
      insert('r2', 'Escalate', '[{"type":"resolve"}]');
      const savedReplyIndexes = () =>
        [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ticket0_saved_replies' ORDER BY name")].map(
          (r) => String(r.name),
        );
      const before = savedReplyIndexes();
      state.storage.transactionSync(() => {
        sql.exec(ticket0Migrations.find((m) => m.version === '0027')!.sql);
      });
      const rows = [
        ...sql.exec('SELECT id, title, owner, folder_id, use_count, last_used_at, actions FROM ticket0_saved_replies ORDER BY id'),
      ];
      const attempt = (id: string, owner: string) => {
        try {
          sql.exec(
            `INSERT INTO ticket0_saved_replies (id, title, body, created_by, created_at, owner)
             VALUES (?, 'Refund', 'x', 'p', '2026-01-02T00:00:00.000Z', ?)`,
            id, owner,
          );
          return 'inserted';
        } catch (e) {
          return /UNIQUE/.test(String(e)) ? 'unique' : String(e);
        }
      };
      const keyed = [attempt('r3', ''), attempt('r4', 'agent-1'), attempt('r5', 'agent-1')];
      const folders = [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket0_saved_reply_folders'")];
      return { before, after: savedReplyIndexes(), rows, keyed, folders: folders.length };
    });
    expect(result.rows).toEqual([
      { id: 'r1', title: 'Refund', owner: '', folder_id: null, use_count: 0, last_used_at: null, actions: null },
      { id: 'r2', title: 'Escalate', owner: '', folder_id: null, use_count: 0, last_used_at: null, actions: '[{"type":"resolve"}]' },
    ]);
    // The old declaration's list indexes were on the table, and went with it.
    expect(result.before).toContainEqual(expect.stringMatching(/^_substrat_list_.*_savedreply_/));
    expect(result.after.filter((n) => n.startsWith('_substrat_list_'))).toEqual([]);
    // The desk keeps one "Refund"; an agent may have their own, once.
    expect(result.keyed).toEqual(['unique', 'inserted', 'unique']);
    expect(result.folders).toBe(1);
  });
});

describe('ticket0 subject erasure on workerd', () => {
  const raw: ErasureSql = async (_tenant, scope, sql, params = []) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
      [...state.storage.sql.exec(sql, ...params)].map((row) => ({ ...row })),
    );

  it('erases only the customer and staff rows that belong to each subject', async () => {
    await checkTicket0SubjectErasure({
      sql: raw,
      prepare: async (tenant, scope) => {
        const response = await platform('/internal/provision', {
          tenantId: tenant, scopeId: scope, owner, entitlements,
        });
        expect(response.status).toBe(201);
      },
      erase: async (_tenant, scope, _actor, subject) => {
        const stub = env.SCOPE.get(env.SCOPE.idFromName(scope)) as DurableObjectStub & {
          redactSubject(id: string): Promise<{ vertical: ModuleErasureCounts } | { failure: unknown }>;
        };
        const result = await stub.redactSubject(subject);
        if ('failure' in result) throw new Error(JSON.stringify(result.failure));
        return result.vertical;
      },
    });
  }, 60_000);

  it('shreds rows stored before the module declared erasure', async () => {
    const oldModules = MODULES.map((module) => module.manifest.id === ticket0Manifest.id
      ? { ...module, manifest: { ...module.manifest, erasure: undefined }, onSubjectErased: undefined }
      : module);
    const OldScopeDO = defineScopeDO(oldModules, {});
    const CurrentScopeDO = defineScopeDO(MODULES, {});
    type ErasureDO = DurableObject & {
      migrate(): Promise<number | null>;
      redactSubject(id: string): Promise<{ vertical: ModuleErasureCounts } | { failure: unknown }>;
    };
    // defineScopeDO's public return type is DurableObject; these are its scope RPCs.
    const opened = (Type: typeof CurrentScopeDO, state: ConstructorParameters<typeof CurrentScopeDO>[0]): ErasureDO =>
      new Type(state, env) as unknown as ErasureDO;
    const stub = (scope: ScopeId) => env.SCOPE.get(env.SCOPE.idFromName(scope));
    await checkTicket0SubjectErasure({
      sql: raw,
      prepare: async (_tenant, scope) => {
        await runInDurableObject(stub(scope), (_instance, state) =>
          opened(OldScopeDO, state).migrate());
      },
      beforeUpgrade: async (tenant, scope, subject) => {
        const result = await runInDurableObject(stub(scope), (_instance, state) =>
          opened(OldScopeDO, state).redactSubject(subject));
        if ('failure' in result) throw new Error(JSON.stringify(result.failure));
        expect(result.vertical.verticalRows).toEqual([]);
        expect(await raw(tenant, scope, 'SELECT body_text FROM ticket0_messages WHERE id = ?', ['customer']))
          .toEqual([{ body_text: 'Customer text' }]);
      },
      upgrade: async (_tenant, scope) => {
        await runInDurableObject(stub(scope), (_instance, state) =>
          opened(CurrentScopeDO, state).migrate());
      },
      erase: async (_tenant, scope, _actor, subject) => {
        const result = await runInDurableObject(stub(scope), (_instance, state) =>
          opened(CurrentScopeDO, state).redactSubject(subject));
        if ('failure' in result) throw new Error(JSON.stringify(result.failure));
        return result.vertical;
      },
    });
  }, 60_000);
});
