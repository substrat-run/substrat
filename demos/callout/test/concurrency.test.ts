/**
 * Two tabs, one facility, one lost update — refused (#129).
 *
 * Driven over **real HTTP**, against the real route table and the real scope
 * host, because every other layer of this feature already has a test that would
 * pass with the wire half broken. The contract suite proves the comparison
 * happens inside the transaction; `operations-routes.test.ts` proves the mount
 * reads and writes the right headers against a stub. Neither would notice if
 * Callout's own `mountApi` never reached them.
 *
 * That gap is not hypothetical here: Callout's scenario test invokes through
 * `stub.invoke` and never touches `src/routes.ts`, so a green suite has never
 * meant a working demo. An `ETag` that the app cannot read is indistinguishable
 * from a feature that is switched off — the browser sends no `If-Match`, the
 * server compares nothing, and every write succeeds.
 *
 * The scenario is the one the issue is about, played straight — as TWO TABS
 * rather than two people, because Anna is Callout's only office-admin and
 * inventing a second one would make the fixture, not the feature, the subject.
 * Two tabs is also the likelier real case:
 *
 * 1. Anna opens the facility in tab A and reads its tag.
 * 2. She opens the same facility in tab B. Same tag.
 * 3. Tab A saves an address correction. It lands.
 * 4. Tab B saves a gate code, still holding the tag from step 2. It is REFUSED —
 *    where before it would have silently reverted the address.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, type DemoWorld } from '../src/index.js';
import { mountApi } from '../src/routes.js';

describe('optimistic concurrency over HTTP (#129)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let app: Hono;

  /** The persona seam the demo already uses: `x-principal` picks who is calling. */
  const as = (principal: string) => ({ 'x-principal': principal });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'callout-concurrency-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    app = new Hono();
    mountApi(app, async (c) => {
      const principal = c.req.header('x-principal');
      if (!principal) throw new Error('no principal');
      return await host.getScope(principal as DemoWorld['anna'], w.t1, w.s1);
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands out a tag on the read and requires it back on the write', async () => {
    const read = await app.request(`/api/facilities/${w.forskolanId}`, { headers: as(w.anna) });
    expect(read.status).toBe(200);
    const tag = read.headers.get('ETag');
    // Quoted, and present. A cross-origin app reads neither without
    // `Access-Control-Expose-Headers` — the trap `CONCURRENCY_EXPOSED_HEADERS`
    // exists for — but this demo serves its app and its API from one origin.
    expect(tag).toMatch(/^"[0-9A-HJKMNP-TV-Z]{26}"$/);

    const write = await app.request(`/api/facilities/${w.forskolanId}`, {
      method: 'PATCH',
      headers: { ...as(w.anna), 'content-type': 'application/json', 'If-Match': tag as string },
      body: JSON.stringify({ accessNote: 'Portkod 2295. Nyckelskåp vid entrén.' }),
    });
    expect(write.status).toBe(200);
    // The write answers with a NEW tag — the row as this write left it, not as the
    // caller found it. A client echoing back what it sent would loop on a stale value.
    expect(write.headers.get('ETag')).not.toBe(tag);
  });

  it('refuses the second of two tabs holding the same tag', async () => {
    const opened = await app.request(`/api/facilities/${w.kontorId}`, { headers: as(w.anna) });
    const shared = opened.headers.get('ETag') as string;

    // Tab A corrects the address.
    const tabA = await app.request(`/api/facilities/${w.kontorId}`, {
      method: 'PATCH',
      headers: { ...as(w.anna), 'content-type': 'application/json', 'If-Match': shared },
      body: JSON.stringify({ address: 'Vasagatan 14, Stockholm' }),
    });
    expect(tabA.status).toBe(200);

    // Tab B adds a gate code, still holding the tag from before tab A saved.
    const tabB = await app.request(`/api/facilities/${w.kontorId}`, {
      method: 'PATCH',
      headers: { ...as(w.anna), 'content-type': 'application/json', 'If-Match': shared },
      body: JSON.stringify({ accessNote: 'Kod 1234' }),
    });
    expect(tabB.status).toBe(412);

    // And the refusal is total: tab A's address survived, and tab B's note was not
    // half-applied. Before this, tab B's save would have reverted the address to
    // what it loaded — silently, with a 200, and with nothing in any log.
    const after = await app.request(`/api/facilities/${w.kontorId}`, { headers: as(w.anna) });
    const row = (await after.json()) as { address: string; access_note: string | null };
    expect(row.address).toBe('Vasagatan 14, Stockholm');
    expect(row.access_note).toBeNull();
  });

  it('re-reading is what lets the refused write proceed', async () => {
    const fresh = await app.request(`/api/facilities/${w.kontorId}`, { headers: as(w.anna) });
    const current = fresh.headers.get('ETag') as string;

    const retry = await app.request(`/api/facilities/${w.kontorId}`, {
      method: 'PATCH',
      headers: { ...as(w.anna), 'content-type': 'application/json', 'If-Match': current },
      body: JSON.stringify({ accessNote: 'Kod 1234' }),
    });
    expect(retry.status).toBe(200);

    // The note landed ON TOP of the address rather than instead of it — which is
    // the whole point. The precondition did not prevent the second edit; it
    // prevented the second edit from being made against a stale copy.
    const row = (await retry.json()) as { address: string; access_note: string | null };
    expect(row.address).toBe('Vasagatan 14, Stockholm');
    expect(row.access_note).toBe('Kod 1234');
  });

  it('a write with no If-Match at all still succeeds', async () => {
    // Opt-in for the CALLER as well as the operation. A script, a seed or an
    // integration that never read the row is not doing read-modify-write and has
    // nothing to be stale against — requiring a header there would be a forced
    // GET round-trip guarding nothing.
    const res = await app.request(`/api/facilities/${w.forskolanId}`, {
      method: 'PATCH',
      headers: { ...as(w.anna), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Förskolan Grunden' }),
    });
    expect(res.status).toBe(200);
  });

  it('answers a caller who may not touch the facility with 403, not 412', async () => {
    // Harald is a technician: no `facility:manage`, narrowed or otherwise. He also
    // holds a stale tag, so both refusals apply — and the permission is the one
    // that must answer.
    //
    // This is the case that found the ordering bug. The precondition originally ran
    // ahead of the handler, so this returned 412 — telling a caller who may not read
    // the facility that it exists AND that it had changed. Both adapters now
    // snapshot the version before the handler and compare after it, so
    // `assertAllowed` inside the handler is what refuses first.
    const stale = '"01J0000000000000000000000Z"';
    const res = await app.request(`/api/facilities/${w.forskolanId}`, {
      method: 'PATCH',
      headers: { ...as(w.harald), 'content-type': 'application/json', 'If-Match': stale },
      body: JSON.stringify({ accessNote: 'should never land' }),
    });
    expect(res.status).toBe(403);
  });
});
