/**
 * #119 (Codex r4): the purge gate's directory facts are read where nothing can interleave.
 *
 * On this adapter a scope's lifecycle lives in the DIRECTORY, a separate database the purge's
 * transaction does not cover, and a suspend does not take the scope's actor. So a hold can land
 * while a purge's handler is suspended on an `await`. The host reads the gate a last time after
 * the handler and before `COMMIT`, with nothing awaited between: here a suspend lands while the
 * handler is paused, and the purge does not commit. Its twin, with no hold, purges.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleId, permissionKey, platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { TBOX_PURGE_DAYS, TRASH_MODULE_ID, trashMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

const DAY = 86_400_000;
const MODULE = moduleId.parse(TRASH_MODULE_ID);

/** The purge's handler, paused on an `await` until the test lets it go. */
let paused: { entered: () => void; release: Promise<void> } | undefined;
const original = trashMod.operations!['trash/delete-box']! as OperationHandler<unknown, unknown>;
const pausing: ModuleRegistration = {
  ...trashMod,
  operations: {
    ...trashMod.operations,
    'trash/delete-box': (async (ctx, input) => {
      if (paused) {
        paused.entered();
        await paused.release;
      }
      return original(ctx, input);
    }) as OperationHandler<unknown, unknown>,
  },
};

describe('the purge gate, read again where no directory write can interleave (#119)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-purge-race-'));
  const host = new SqliteScopeHost({ dir });
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const keys = ['box:read', 'box:write', 'box:archive', 'box:trash', 'box:delete'].map((k) => permissionKey.parse(k));
  const internals = host as unknown as {
    runtime(t: unknown, s: unknown): { db: { prepare(q: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown } } };
  };
  const raw = (s: ScopeId) => internals.runtime(t, s).db;

  beforeAll(async () => {
    host.registerModule(pausing);
    await host.admin.createTenant(staff, { id: t, slug: `race-${t.slice(-10).toLowerCase()}`, name: 'Race' });
    await host.admin.grantEntitlement(staff, t, 'trash');
    await host.admin.defineRole(staff, t, { key: 'boxer', permissions: keys, source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'boxer', node: { tenantId: t, scopeId: null } });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh scope holding one box that has sat in the bin past the horizon. */
  const dueScope = async (): Promise<{ s: ScopeId; id: string }> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    const id = ulid();
    const as = await host.getScope(alice, t, s);
    await as.invoke('trash/add-box', { id, name: 'box' });
    await as.invoke('trash/trash-box', { boxId: id });
    const at = new Date(Date.now() - (TBOX_PURGE_DAYS + 1) * DAY).toISOString();
    raw(s).prepare(`INSERT INTO _substrat_state_moves (entity_type, entity_id) VALUES ('tbox', ?)`).run(id);
    raw(s).prepare('UPDATE trash_boxes SET _substrat_trashed_at = ? WHERE id = ?').run(at, id);
    raw(s).prepare(`DELETE FROM _substrat_state_moves WHERE entity_type = 'tbox'`).run();
    return { s, id };
  };
  const present = (s: ScopeId, id: string) => raw(s).prepare('SELECT 1 FROM trash_boxes WHERE id = ?').get(id) !== undefined;

  /** Run the scope's sweep with the purge paused inside its handler; `during` runs while it waits. */
  const sweepPaused = async (s: ScopeId, during: () => Promise<void>) => {
    let entered!: () => void;
    const inHandler = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    paused = { entered, release: new Promise<void>((resolve) => (release = resolve)) };
    try {
      const sweep = host.runDueSchedules(MODULE, t, s);
      await inHandler;
      await during();
      release();
      return await sweep;
    } finally {
      paused = undefined;
    }
  };

  it('a suspend that lands while the purge handler awaits keeps the entity: the purge does not commit', async () => {
    const { s, id } = await dueScope();
    const report = await sweepPaused(s, () => host.admin.suspendScope(staff, t, s));
    expect(present(s, id)).toBe(true);
    // Held, not failed: the entity stays in the bin for the first pass after the scope is live.
    expect(report).toMatchObject({ failed: 0, errors: [] });
  });

  it('twin: with no hold landing, the same paused purge commits', async () => {
    const { s, id } = await dueScope();
    const report = await sweepPaused(s, async () => undefined);
    expect(present(s, id)).toBe(false);
    expect(report).toMatchObject({ fired: 1, failed: 0 });
  });
});
