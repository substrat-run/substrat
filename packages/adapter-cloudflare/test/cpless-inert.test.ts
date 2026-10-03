import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { permissionKey, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { INERT_SCOPE_REASON, ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';

/**
 * #2005 on a CP-LESS host — the hosted-vertical shape, with no control-plane directory to ask
 * what kind of scope it serves. A preview or a snapshot reaches such a vertical as a restore,
 * and every copy records that it is one (`_substrat_copy_origin`), so the coordinator reads the
 * scope's own storage instead: a copy's plain executor never runs, and its delivery is journaled
 * inert. (A connector never runs on a CP-less host at all; that is #574's routing.)
 */
describe('a CP-less host holds a copy inert by its own storage (#2005)', () => {
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const ran: string[] = [];
  let install: ScopeId;

  const hostFor = () => {
    // No `controlPlane` binding.
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    host.registerExecutor('cpless-effector', 'perm.acted', async (_admin, event) => {
      ran.push(event.scopeId);
    });
    return host;
  };
  const seat = (s: ScopeId) =>
    hostFor().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  const act = async (s: ScopeId) => (await hostFor().getScope(owner, t, s)).invoke('perm/authorized-emit', { permission: USE });
  const inertIn = async (s: ScopeId) =>
    (await hostFor().executorDeadLetters(t, s)).filter((d) => d.error === INERT_SCOPE_REASON).length;

  beforeAll(async () => {
    install = scopeId.parse(ulid());
    await seat(install);
  });

  it('twin: an install runs its plain executor', async () => {
    await act(install);
    expect(ran).toEqual([install]);
    expect(await inertIn(install)).toBe(0);
  });

  it("a copy (a preview fork or a snapshot, restored from the install's export): held inert", async () => {
    const copy = scopeId.parse(ulid());
    await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(install), { sourceScopeId: install });
    await act(copy);
    expect(ran).not.toContain(copy);
    expect(await inertIn(copy)).toBe(1);
    // Terminal: the retry driver neither runs it nor journals it again.
    expect((await hostFor().drainDue(t, copy)).attempted).toBe(0);
    expect(ran).not.toContain(copy);
  });

  it('a clean-room preview (a restore of nothing, then seated): held inert', async () => {
    const clean = scopeId.parse(ulid());
    await hostFor().restoreScopeLocal(clean, []);
    await seat(clean);
    await act(clean);
    expect(ran).not.toContain(clean);
    expect(await inertIn(clean)).toBe(1);
  });

  // A copy made before every copy carried the marker, or a same-scope carry of one, holds no
  // row: on its own storage it reads as an install. The platform, which has the directory, marks it.
  describe('a copy that predates the marker (#2005)', () => {
    /** A scope this deployment holds with no origin row, as such a copy does. */
    const legacy = async () => {
      const s = scopeId.parse(ulid());
      await seat(s);
      return s;
    };
    const originOf = async (s: ScopeId) =>
      (await hostFor().exportScopeLocal(s)).find((t) => t.name === '_substrat_copy_origin')?.rows ?? [];

    it('reads as an install until it is marked — the gap this closes', async () => {
      const s = await legacy();
      await act(s);
      expect(ran).toContain(s);
    });

    it('a carry the platform flags (markCopy) stamps it, and its executors are then inert', async () => {
      const s = await legacy();
      await hostFor().restoreScopeLocal(s, await hostFor().exportScopeLocal(s), { sourceScopeId: s, exact: true, markCopy: true });
      await act(s);
      expect(ran).not.toContain(s);
      expect(await inertIn(s)).toBe(1);
    });

    it('twin: the same carry unflagged leaves an install an install', async () => {
      const s = await legacy();
      await hostFor().restoreScopeLocal(s, await hostFor().exportScopeLocal(s), { sourceScopeId: s, exact: true });
      await act(s);
      expect(ran).toContain(s);
      expect(await originOf(s)).toEqual([]);
    });

    it('the repair verb stamps once, answers whether it did, and then holds it inert', async () => {
      const s = await legacy();
      expect(await hostFor().markCopyLocal(s)).toEqual({ marked: true });
      expect(await hostFor().markCopyLocal(s)).toEqual({ marked: false });
      await act(s);
      expect(ran).not.toContain(s);
    });

    it("the next case along: an existing origin is kept as it is — its mark and source", async () => {
      const copy = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(install), { sourceScopeId: install });
      const before = await originOf(copy);
      expect(before).toHaveLength(1);
      expect(await hostFor().markCopyLocal(copy)).toEqual({ marked: false });
      await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(copy), { sourceScopeId: copy, exact: true, markCopy: true });
      expect(await originOf(copy)).toEqual(before);
    });
  });

  it("the next case along: the install's own backup returned to it is still the install", async () => {
    await hostFor().restoreScopeLocal(install, await hostFor().exportScopeLocal(install), { sourceScopeId: install });
    const before = ran.length;
    await act(install);
    expect(ran.slice(before)).toEqual([install]);
  });
});
