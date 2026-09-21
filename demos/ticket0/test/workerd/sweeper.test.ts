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
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  principalId,
  scopeId,
  tenantId,
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
