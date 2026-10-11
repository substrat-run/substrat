/**
 * The storage-side fence on a real todo scope, in one process (#1638 Q2).
 *
 * A takeover stamps a newer epoch into the scope's files. After that, a holder still on the
 * old epoch has every write refused inside its own transaction: an operation that emits, and
 * a write that emits nothing. The positive twin: the holder of the new epoch writes as before.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { principalId, scopeId as scopeIdOf, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { FENCE_GUARD_REFUSAL, FENCE_REFUSAL, holdEpoch, installEpochFunction, StaleStamp, stampFence } from '../src/storage-fence.js';
import { scopeDir, seedScope, type ScopeWorld } from '../src/todo-scope.js';

installEpochFunction();

const volume = mkdtempSync(join(tmpdir(), 'k3s-sharding-fence-'));
const scope = ulid();
const dir = scopeDir(volume, 'todo-0', scope);
let host: ScopeHost;
let world: ScopeWorld;

beforeAll(async () => {
  holdEpoch(scope, 1);
  ({ host, world } = await seedScope(dir, scope));
  stampFence(dir, 1);
});
afterAll(async () => {
  await host.close();
  rmSync(volume, { recursive: true, force: true });
});

const add = async (text: string) => {
  const stub = await host.getScope(principalId.parse(world.member), tenantId.parse(world.tenant), scopeIdOf.parse(world.scope));
  return stub.invoke('todo/add-item', { listId: world.listId, text });
};

/** The scope file that holds the todo tables (the directory database sits beside it). */
function todoFile(): string {
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.sqlite'))) {
    const db = new Database(join(dir, name), { readonly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'todo_items'").get()) return join(dir, name);
    } finally {
      db.close();
    }
  }
  throw new Error('no file holds todo_items');
}

/** The epoch stamped in each SQLite file of the scope. */
function fenceEpochs(): number[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sqlite'))
    .map((n) => {
      const db = new Database(join(dir, n), { readonly: true });
      try {
        return db.prepare<[], { epoch: number }>('SELECT epoch FROM _k3s_fence').get()!.epoch;
      } finally {
        db.close();
      }
    });
}

/** A write that emits nothing, on its own connection to the scope's file. */
function silentWrite(): void {
  const db = new Database(todoFile());
  try {
    db.prepare('UPDATE todo_items SET done = 1').run();
  } finally {
    db.close();
  }
}

describe('storage fence', () => {
  it('lets the current holder write', async () => {
    await expect(add('a')).resolves.toMatchObject({ text: 'a' });
  });

  it('refuses an emitting write by the old epoch once a takeover stamped a newer one', async () => {
    stampFence(dir, 2);
    await expect(add('b')).rejects.toThrow(FENCE_REFUSAL);
  });

  it('refuses a write that emits nothing, too — the trigger is on every table, not the outbox', () => {
    expect(() => silentWrite()).toThrow(FENCE_REFUSAL);
  });

  it('the holder of the new epoch writes as before', async () => {
    holdEpoch(scope, 2);
    await expect(add('c')).resolves.toMatchObject({ text: 'c' });
    expect(() => silentWrite()).not.toThrow();
  });

  it('stamps only upward: an older takeover is refused and the newer epoch stays', async () => {
    expect(() => stampFence(dir, 1)).toThrow(StaleStamp);
    expect(fenceEpochs()).toEqual([2, 2]);
    await expect(add('d')).resolves.toMatchObject({ text: 'd' });
  });

  it('guards the fence row itself: a stale holder cannot stamp its own epoch and then write', () => {
    holdEpoch(scope, 1);
    const db = new Database(todoFile());
    try {
      expect(() => db.prepare('UPDATE _k3s_fence SET epoch = k3s_holder_epoch()').run()).toThrow(FENCE_GUARD_REFUSAL);
      expect(() => db.prepare('DELETE FROM _k3s_fence').run()).toThrow(FENCE_GUARD_REFUSAL);
      expect(() => db.prepare('INSERT INTO _k3s_fence (epoch) VALUES (1)').run()).toThrow(FENCE_GUARD_REFUSAL);
    } finally {
      db.close();
    }
    expect(fenceEpochs()).toEqual([2, 2]);
    expect(() => silentWrite()).toThrow(FENCE_REFUSAL);
    holdEpoch(scope, 2);
  });
});
