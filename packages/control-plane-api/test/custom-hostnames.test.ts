import { describe, it, expect, vi } from 'vitest';
import {
  createCustomHostnameProvisioner,
  mapCfStatus,
  extractRecords,
  reconcilePendingHostnames,
  type CustomHostnameProvisioner,
  type HostnameReconcileAdmin,
} from '../src/custom-hostnames.js';
import type { HostnameBinding, PlatformActorId } from '@substrat-run/contracts';

const ACTOR = 'staff:test' as PlatformActorId;

/** A Cloudflare custom-hostname result at various stages, minimal but real-shaped. */
const cfResult = (over: Record<string, unknown> = {}) => ({
  id: 'ch_123',
  hostname: 'legal.acme.com',
  status: 'pending',
  ssl: {
    status: 'pending_validation',
    validation_records: [{ txt_name: '_cf.legal.acme.com', txt_value: 'token-abc', status: 'pending' }],
  },
  ...over,
});

const envelope = (result: unknown, over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ success: true, result, ...over }), { status: 200 });

describe('mapCfStatus', () => {
  it('maps both-active to active', () => {
    expect(mapCfStatus({ id: 'x', hostname: 'h', status: 'active', ssl: { status: 'active' } })).toEqual({
      status: 'active',
      note: null,
    });
  });
  it('maps mid-flight states to verifying', () => {
    expect(mapCfStatus(cfResult()).status).toBe('verifying');
    expect(mapCfStatus({ id: 'x', hostname: 'h', status: 'pending', ssl: { status: 'initializing' } }).status).toBe(
      'verifying',
    );
  });
  it('maps terminal-bad states to failed with a note', () => {
    const m = mapCfStatus({ id: 'x', hostname: 'h', status: 'blocked', verification_errors: ['nope'] });
    expect(m.status).toBe('failed');
    expect(m.note).toContain('nope');
  });
  it('defaults an unknown state to verifying, not failed', () => {
    expect(mapCfStatus({ id: 'x', hostname: 'h', status: 'brand_new_state' }).status).toBe('verifying');
  });
});

describe('extractRecords', () => {
  it('always includes the routing CNAME plus any DCV TXT, deduped', () => {
    const recs = extractRecords(
      cfResult({ ownership_verification: { type: 'txt', name: '_cf.legal.acme.com', value: 'dup' } }),
      'edge.substrat.run',
    );
    expect(recs[0]).toMatchObject({ type: 'hostname', name: 'legal.acme.com', value: 'edge.substrat.run' });
    const txts = recs.filter((r) => r.type === 'txt');
    // The ownership_verification name duplicates the ssl validation record — deduped.
    expect(txts).toHaveLength(1);
    expect(txts[0]).toMatchObject({ name: '_cf.legal.acme.com', value: 'token-abc' });
  });
});

describe('createCustomHostnameProvisioner', () => {
  const provisioner = (fetchFn: typeof fetch) =>
    createCustomHostnameProvisioner({
      zoneId: 'zone1',
      apiToken: 'tok',
      routingTarget: 'edge.substrat.run',
      fetch: fetchFn as never,
    });

  it('create POSTs to the zone custom_hostnames endpoint and returns issuance', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({ hostname: 'legal.acme.com', ssl: { method: 'txt' } });
      return envelope(cfResult());
    });
    const r = await provisioner(fetchFn as never).create('LEGAL.acme.com'); // upper-cased on the way in
    expect(r).toMatchObject({ customHostnameId: 'ch_123', status: 'verifying', note: null });
    expect(r.records.some((x) => x.type === 'txt')).toBe(true);
  });

  it('check GETs the hostname by id and maps active', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames/ch_123');
      return envelope(cfResult({ status: 'active', ssl: { status: 'active' } }));
    });
    const r = await provisioner(fetchFn as never).check('ch_123');
    expect(r.status).toBe('active');
  });

  it('throws with the CF error messages on a non-success envelope', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'zone not enabled' }] }), { status: 403 }),
    );
    await expect(provisioner(fetchFn as never).create('x.acme.com')).rejects.toThrow(/zone not enabled/);
  });

  it('names the platform token, not the tenant DNS, on a create auth failure', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'Authentication error' }] }), { status: 403 }),
    );
    await expect(provisioner(fetchFn as never).create('crm.acme.com')).rejects.toThrow(
      /SSL and Certificates: Edit/,
    );
  });

  it('remove tolerates a 404 as already-gone', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));
    await expect(provisioner(fetchFn as never).remove('ch_gone')).resolves.toBeUndefined();
  });
});

describe('reconcilePendingHostnames', () => {
  const binding = (over: Partial<HostnameBinding>): HostnameBinding => ({
    hostname: 'legal.acme.com',
    tenantId: 't1' as HostnameBinding['tenantId'],
    scopeId: 's1' as HostnameBinding['scopeId'],
    verticalSlug: null,
    surface: 'app',
    region: null,
    status: 'verifying',
    statusNote: null,
    canonical: true,
    createdAt: '2026-07-29T00:00:00.000Z' as HostnameBinding['createdAt'],
    customHostnameId: 'ch_123',
    validationRecords: [],
    ...over,
  });

  it('polls verifying rows and records activation', async () => {
    const writes: { hostname: string; status: string }[] = [];
    const admin: HostnameReconcileAdmin = {
      listHostnames: async (_a, filter) =>
        filter?.status === 'verifying' ? [binding({})] : [],
      setHostnameIssuance: async (_a, hostname, fields) => {
        writes.push({ hostname, status: fields.status });
      },
    };
    const provisioner = {
      check: async () => ({ customHostnameId: 'ch_123', status: 'active' as const, note: null, records: [] }),
      create: vi.fn(),
      remove: vi.fn(),
    } as unknown as CustomHostnameProvisioner;

    const out = await reconcilePendingHostnames({ admin, actor: ACTOR, provisioner, isCustom: () => true });
    expect(out).toMatchObject({ polled: 1, activated: 1, failed: 0 });
    expect(writes).toEqual([{ hostname: 'legal.acme.com', status: 'active' }]);
  });

  it('retries create for a stuck pending custom row, skipping platform mints', async () => {
    const created: string[] = [];
    const admin: HostnameReconcileAdmin = {
      listHostnames: async (_a, filter) =>
        filter?.status === 'pending'
          ? [
              binding({ hostname: 'legal.acme.com', status: 'pending', customHostnameId: null }),
              binding({ hostname: 'acme-app.substrat.run', status: 'pending', customHostnameId: null }),
            ]
          : [],
      setHostnameIssuance: async () => {},
    };
    const provisioner = {
      create: async (h: string) => {
        created.push(h);
        return { customHostnameId: 'ch_new', status: 'verifying' as const, note: null, records: [] };
      },
      check: vi.fn(),
      remove: vi.fn(),
    } as unknown as CustomHostnameProvisioner;

    const out = await reconcilePendingHostnames({
      admin,
      actor: ACTOR,
      provisioner,
      isCustom: (h) => !h.endsWith('.substrat.run'),
    });
    expect(out.created).toBe(1);
    expect(created).toEqual(['legal.acme.com']); // the platform mint was skipped
  });

  it('retries create for a failed row with no CF id (create never landed), not a failed row with one', async () => {
    const created: string[] = [];
    const admin: HostnameReconcileAdmin = {
      listHostnames: async (_a, filter) =>
        filter?.status === 'failed'
          ? [
              // A create that never landed (e.g. token without the permission) — retriable.
              binding({ hostname: 'crm.acme.com', status: 'failed', customHostnameId: null }),
              // A real validation verdict from CF — terminal for the sweep.
              binding({ hostname: 'dead.acme.com', status: 'failed', customHostnameId: 'ch_dead' }),
            ]
          : [],
      setHostnameIssuance: async () => {},
    };
    const provisioner = {
      create: async (h: string) => {
        created.push(h);
        return { customHostnameId: 'ch_new', status: 'verifying' as const, note: null, records: [] };
      },
      check: vi.fn(),
      remove: vi.fn(),
    } as unknown as CustomHostnameProvisioner;

    const out = await reconcilePendingHostnames({ admin, actor: ACTOR, provisioner, isCustom: () => true });
    expect(out.created).toBe(1);
    expect(created).toEqual(['crm.acme.com']);
  });

  it('contains a per-row failure without sinking the pass', async () => {
    const admin: HostnameReconcileAdmin = {
      listHostnames: async (_a, filter) => (filter?.status === 'verifying' ? [binding({})] : []),
      setHostnameIssuance: async () => {},
    };
    const provisioner = {
      check: async () => {
        throw new Error('cloudflare 500');
      },
      create: vi.fn(),
      remove: vi.fn(),
    } as unknown as CustomHostnameProvisioner;
    const out = await reconcilePendingHostnames({ admin, actor: ACTOR, provisioner, isCustom: () => true });
    expect(out.errors).toEqual([{ hostname: 'legal.acme.com', error: 'cloudflare 500' }]);
  });
});
