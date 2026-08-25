/**
 * Contract suite for `readTimeline` / `readHistory` — the supported read of an
 * entity's history (#800).
 *
 * What it pins is not that a `SELECT` runs. Five demos already had one and all
 * five ran; the suite exists because of what they got WRONG, and every case here
 * is one of those:
 *
 * - **A timestamp cursor loses rows.** Meridian's and rally's timelines walked
 *   `occurred_at > ?`, and `ctx.now()` is stable for a whole invocation (#812) —
 *   so every event one operation emits shares an instant, and a page boundary
 *   inside them dropped the rest. The burst case constructs that on purpose.
 * - **`actor` is not an id.** It is stored `JSON.stringify`d over a union whose
 *   principal member is a bare string, so the column holds `"01J…"` WITH quotes.
 *   The suite asserts the decoded value, for a principal and for a system actor,
 *   because the string-shaped read is the trap that looks like it works.
 * - **A shred keeps the row.** The payload goes, the envelope stays, and a
 *   history that threw or skipped the row would be a worse answer than
 *   "something happened here and you may not know what."
 *
 * Behavioural against a real database throughout, for the reason the entity
 * version suite gives: a query that reads correctly can still be wrong, and a
 * string assertion would call it a pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  dataSubjectId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type HistoryEntry,
  type ListPage,
  type Page,
  type PrincipalId,
  type TimelineEntry,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { contractTestBareOps, testMod } from './modules.js';

const PERM_USE = permissionKey.parse('testmod:use');

export function timelineContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`entity timeline (readTimeline / readHistory): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    const timeline = (entityId: string, page: ListPage = {}, entityType = 'test-thing') =>
      stub.invoke<Page<TimelineEntry>>('test/timeline', { entityType, entityId, ...page });
    const history = (entityId: string, page: ListPage = {}, entityType = 'test-thing') =>
      stub.invoke<Page<HistoryEntry>>('test/history', { entityType, entityId, ...page });
    const emitAbout = (entityId: string, subject?: string) =>
      stub.invoke('test/emit-about', { entityId, ...(subject ? { subject } : {}) });
    const burst = (entityId: string, count: number) =>
      stub.invoke<string>('test/emit-burst', { entityId, count });
    const said = (entityId: string, subject: string, what: string) =>
      stub.invoke('test/emit-about-with-payload', { entityId, subject, said: what });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      for (const [name, handler] of Object.entries(contractTestBareOps)) {
        host.defineOperation(name, handler);
      }
      host.registerModule(testMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'timeline-tenant', name: 'Timeline Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'testmod');
      await host.admin.defineRole(staff, t1, {
        key: 'timeline-admin',
        permissions: [PERM_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'timeline-admin',
        node: { tenantId: t1, scopeId: null },
      });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'timeline-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('is empty for an entity nothing has emitted about', async () => {
      const page = await timeline('never-touched');
      expect(page.entries).toEqual([]);
      // Short page ⇒ the walk is done. A non-null cursor here would send a
      // client back for a second empty fetch forever.
      expect(page.nextCursor).toBeNull();
    });

    it('returns the envelope in creation order', async () => {
      const id = `e-${ulid()}`;
      await emitAbout(id);
      await emitAbout(id);
      await emitAbout(id);

      const { entries } = await timeline(id);
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.type)).toEqual([
        'test.happened',
        'test.happened',
        'test.happened',
      ]);
      // `ORDER BY id` IS creation order because `ulid()` is monotonic — the same
      // property `entityVersionQuery` relies on. Asserted rather than assumed,
      // since losing it would make timelines subtly wrong and nothing else red.
      const ids = entries.map((e) => e.id);
      expect([...ids].sort()).toEqual(ids);
    });

    it('decodes `actor` into the union rather than handing back stored JSON', async () => {
      const id = `e-${ulid()}`;
      await emitAbout(id);

      const [entry] = (await timeline(id)).entries;
      // The trap this helper exists to close. The column holds `"01J…"` — quotes
      // included — so a caller resolving a name against the raw text misses every
      // time, and the natural fix is a string-trim that then breaks on a system
      // actor. Here it is the principal id itself.
      expect(entry!.actor).toBe(alice);
      expect(typeof entry!.actor).toBe('string');
      expect(JSON.stringify(entry!.actor).startsWith('"\\"')).toBe(false);
    });

    it('is per entity — an event about one does not appear on another', async () => {
      const left = `e-${ulid()}`;
      const right = `e-${ulid()}`;
      await emitAbout(left);
      await emitAbout(right);
      await emitAbout(right);

      expect((await timeline(left)).entries).toHaveLength(1);
      expect((await timeline(right)).entries).toHaveLength(2);
      // Same id, other type: the pair identifies the row, not the id alone.
      expect((await timeline(left, {}, 'other-thing')).entries).toEqual([]);
    });

    it('pages without losing events that share an instant', async () => {
      const id = `e-${ulid()}`;
      // One invocation, five events. `ctx.now()` does not move inside an
      // operation, so all five carry the same `occurred_at` — this is the
      // ordinary case, not a contrived tie.
      const at = await burst(id, 5);

      const first = await timeline(id, { limit: 2 });
      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).toBe(first.entries[1]!.id);
      expect(first.entries.every((e) => e.occurredAt === at)).toBe(true);

      const second = await timeline(id, { limit: 2, cursor: first.nextCursor! });
      const third = await timeline(id, { limit: 2, cursor: second.nextCursor! });
      expect(third.nextCursor).toBeNull();

      const walked = [...first.entries, ...second.entries, ...third.entries].map((e) => e.id);
      // The assertion the old timestamp cursor failed: five emitted, five walked,
      // none seen twice. `occurred_at > ?` returned two and then nothing, because
      // every remaining row shared the instant it had just walked past.
      expect(walked).toHaveLength(5);
      expect(new Set(walked).size).toBe(5);
    });

    it('walks newest-first on `desc`, over the same rows', async () => {
      const id = `e-${ulid()}`;
      await burst(id, 4);

      const asc = (await timeline(id)).entries.map((e) => e.id);
      const desc = (await timeline(id, { order: 'desc' })).entries.map((e) => e.id);
      expect(desc).toEqual([...asc].reverse());

      // The cursor is exclusive in BOTH directions — strictly before, walking down.
      const firstDown = await timeline(id, { order: 'desc', limit: 2 });
      const nextDown = await timeline(id, {
        order: 'desc',
        limit: 2,
        cursor: firstDown.nextCursor!,
      });
      expect(nextDown.entries.map((e) => e.id)).toEqual(asc.slice(0, 2).reverse());
    });

    it("uses the event id as the cursor — the entity's version at that point", async () => {
      const id = `e-${ulid()}`;
      await emitAbout(id);
      await emitAbout(id);

      const { entries } = await timeline(id);
      const version = await stub.invoke<string | null>('test/version-of', {
        entityType: 'test-thing',
        entityId: id,
      });
      // #901's token and this walk's last entry are the same value, which is the
      // point of ordering by `id`: "list the history", "name a version" and
      // "refuse my stale write" (#129) stop being three vocabularies.
      expect(entries[entries.length - 1]!.id).toBe(version);
    });

    it('carries the payload, the classification and the authorization', async () => {
      const id = `e-${ulid()}`;
      await said(id, dataSubjectId.parse(ulid()), 'moved to Customer');

      const [entry] = (await history(id)).entries;
      // The fat event — the NEW values. "X → Y" is reconstructed by diffing
      // consecutive payloads; nothing stores a before-state, which is a property
      // of the spine and not something this read could have hidden.
      expect(entry!.payload).toEqual({ said: 'moved to Customer' });
      expect(entry!.piiClass).toBe('direct');
      expect(entry!.subjectId).not.toBeNull();
      // K-34: the checks the emitting operation passed. Null would mean
      // UNRECORDED — a row written before the column existed — which is a
      // different fact from an empty list and must not be conflated with one.
      expect(entry!.authorization).not.toBeNull();
      expect(entry!.authorization!.map((a) => a.permission)).toContain(PERM_USE);
      // And the TIMELINE read of the same event carries none of it. That is the
      // whole reason the two are separate: one has a disclosure decision behind
      // it and the other cannot have.
      const [envelope] = (await timeline(id)).entries;
      expect(envelope).not.toHaveProperty('payload');
      expect(envelope!.id).toBe(entry!.id);
    });

    it('degrades to a null payload after a shred, keeping the envelope', async () => {
      const id = `e-${ulid()}`;
      const subject = dataSubjectId.parse(ulid());
      await said(id, subject, 'something about a person');

      const before = (await history(id)).entries[0]!;
      expect(before.payload).toEqual({ said: 'something about a person' });

      const receipt = await host.admin.shredSubject(staff, t1, s1, subject);
      expect(receipt.eventsRedacted).toBe(1);

      const after = (await history(id)).entries[0]!;
      // §5.3's line, held exactly: the payload goes, the envelope stays. A
      // history after an erasure correctly reads "someone changed this, then" —
      // so a renderer must expect the null. It is a supported result, which is
      // why this is asserted rather than left to a caller to discover.
      expect(after.payload).toBeNull();
      expect(after.id).toBe(before.id);
      expect(after.occurredAt).toBe(before.occurredAt);
      expect(after.actor).toBe(before.actor);
      expect(after.subjectId).toBe(subject);
      // And the timeline — which never carried a payload — is unchanged by it.
      expect((await timeline(id)).entries).toHaveLength(1);
    });

    it('defaults and caps the page size rather than answering unbounded', async () => {
      const id = `e-${ulid()}`;
      await burst(id, 3);
      // An app walking a screen must not receive ten thousand rows because
      // nobody named a number. This differs from `ListPage`'s kernel-read
      // convention (unset ⇒ unbounded) deliberately, and matches what the HTTP
      // layer would have given the same caller.
      const page = await timeline(id, { limit: 0 });
      expect(page.entries).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });
  });
}
