import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page, TimelineEntry } from '@substrat-run/contracts';
import { manualClock, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, type ManyfoldWorld, type EntryRow, type EntryStatus } from '../src/index.js';

/**
 * The Manyfold scenario (spec/concept.md §"scenario"): provision three sites →
 * append-only revisions → restore → the workflow denials hold → priced-by-nobody
 * publish freezes with a hash → delivery serves the frozen revision and resolves
 * references (draft = unresolved, then resolved) → scope isolation → archive → the
 * state machine can't skip.
 */
describe('Manyfold demo scenario', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: ManyfoldWorld;
  let sofiaCafe: ScopeStub; // author@cafe
  let emilCafe: ScopeStub; // publisher@cafe
  let emilLaw: ScopeStub; // viewer@law
  let sofiaPadel: ScopeStub; // NO role on padel
  let postId: string;
  let snippetId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-manyfold-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    sofiaCafe = await host.getScope(w.sofia, w.t1, w.cafe);
    emilCafe = await host.getScope(w.emil, w.t1, w.cafe);
    emilLaw = await host.getScope(w.emil, w.t1, w.law);
    sofiaPadel = await host.getScope(w.sofia, w.t1, w.padel);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions three sites and applies the module journal per scope', () => {
    for (const scope of [w.cafe, w.padel, w.law]) {
      const db = new Database(join(dir, `${w.t1}__${scope}.sqlite`), { readonly: true });
      const versions = db
        .prepare("SELECT version FROM _substrat_migrations WHERE module_id = '@substrat-run/demo-manyfold' ORDER BY version")
        .all() as { version: string }[];
      db.close();
      expect(versions.map((v) => v.version)).toEqual(['0001-init', '0002-content-types', '0003-list-indexes']);
    }
  });

  it('1a. an admin requests a new site — a provision-sibling intent is enqueued; an author cannot', async () => {
    const maja = await host.getScope(w.maja, w.t1, w.cafe); // admin@cafe

    // Requesting a site is `content:manage-sites` — an author lacks it.
    await expect(sofiaCafe.invoke('manyfold/request-site', { slug: 'padel', name: 'Padel' })).rejects.toThrow(
      /permission denied/,
    );

    const { requestId } = await maja.invoke<{ requestId: string }>('manyfold/request-site', {
      slug: 'padel',
      name: 'Padel Club',
    });
    expect(requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // The vertical can't provision itself (sandbox-clean) — it enqueues a durable platform intent
    // in this scope for the platform to drain (platform-intents.md). Owner = the requesting admin.
    const pending = await host.listPlatformRequests(w.t1, w.cafe);
    const mine = pending.find((r) => r.id === requestId)!;
    expect(mine.kind).toBe('provision-sibling');
    expect(mine.status).toBe('pending');
    expect(mine.payload).toEqual({ slug: 'padel', name: 'Padel Club', owner: w.maja });
  });

  it('1a2. an admin archives a site — an archive-scope intent naming the target is enqueued; an author cannot', async () => {
    const maja = await host.getScope(w.maja, w.t1, w.cafe); // admin@cafe

    await expect(sofiaCafe.invoke('manyfold/archive-site', { scopeId: w.law })).rejects.toThrow(/permission denied/);

    const { requestId } = await maja.invoke<{ requestId: string }>('manyfold/archive-site', { scopeId: w.law });
    const mine = (await host.listPlatformRequests(w.t1, w.cafe)).find((r) => r.id === requestId)!;
    expect(mine.kind).toBe('archive-scope');
    expect(mine.payload).toEqual({ scopeId: w.law }); // the platform verifies + archives the target
  });

  it('1b. modelling: an admin creates a content type; it drives create-entry immediately', async () => {
    const maja = await host.getScope(w.maja, w.t1, w.cafe); // admin@cafe
    // The four defaults are seeded lazily on first use. Paged (#1833, Copilot
    // review PR #1843): `save-type` has no cap, so this is a page envelope like
    // every other list here, not a bare array.
    const typesPage = await maja.invoke<Page<{ key: string; def: { key: string } }>>('manyfold/list-types');
    const types = typesPage.entries;
    expect(types.map((t) => t.def.key).sort()).toEqual(['author', 'page', 'post', 'snippet']);

    // Author cannot model — that's an admin act.
    await expect(
      sofiaCafe.invoke('manyfold/save-type', { key: 'recipe', title: 'Recipe', titleField: 'name', fields: { name: { type: 'text', required: true } } }),
    ).rejects.toThrow(/permission denied/);

    // Admin creates a new type with a reference to an existing one…
    const recipe = await maja.invoke<{ key: string; version: number; fields: Record<string, unknown> }>('manyfold/save-type', {
      key: 'recipe',
      title: 'Recipe',
      titleField: 'name',
      slugField: 'slug',
      fields: {
        name: { type: 'text', required: true },
        slug: { type: 'slug', source: 'name' },
        steps: { type: 'richText' },
        author: { type: 'ref', target: 'author' },
      },
    });
    expect(recipe.version).toBe(1);

    // …and it is immediately usable by the content editor: create an entry of the new type.
    const entry = await maja.invoke<{ id: string; type_key: string }>('manyfold/create-entry', {
      typeKey: 'recipe',
      body: { name: 'Cortado', slug: 'cortado', steps: 'Pull a double, add warm milk.' },
    });
    expect(entry.type_key).toBe('recipe');

    // An unknown field is rejected by the type's generated schema.
    await expect(
      maja.invoke('manyfold/create-entry', { typeKey: 'recipe', body: { name: 'X', bogus: 1 } }),
    ).rejects.toThrow(/Unrecognized|unknown|bogus/i);

    // Editing the type bumps its version (schema evolution = a new version).
    const v2 = await maja.invoke<{ version: number }>('manyfold/save-type', {
      key: 'recipe', title: 'Recipe', titleField: 'name', slugField: 'slug',
      fields: { name: { type: 'text', required: true }, slug: { type: 'slug', source: 'name' }, steps: { type: 'richText' }, minutes: { type: 'int' } },
    });
    expect(v2.version).toBe(2);

    // Delete is blocked while entries exist.
    await expect(maja.invoke('manyfold/delete-type', { key: 'recipe' })).rejects.toThrow(/cannot delete type/);
  });

  it('2. author creates a Post and appends a second revision (append-only)', async () => {
    const post = await sofiaCafe.invoke<EntryRow>('manyfold/create-entry', {
      typeKey: 'post',
      body: { title: 'Hello world', slug: 'hello', body: 'First draft.', category: 'news' },
    });
    postId = post.id;
    expect(post.status).toBe('draft');
    expect(post.draft_rev).toBe(1);

    const r2 = await sofiaCafe.invoke<EntryRow>('manyfold/save-draft', {
      entryId: postId,
      body: { title: 'Hello world', slug: 'hello', body: 'Second draft.', category: 'news' },
    });
    expect(r2.draft_rev).toBe(2);
  });

  it('3. restore is a NEW revision copying an old body (history never mutated)', async () => {
    const restored = await sofiaCafe.invoke<EntryRow>('manyfold/restore-revision', { entryId: postId, revNo: 1 });
    expect(restored.draft_rev).toBe(3);
    const detail = await sofiaCafe.invoke<{ body: Record<string, unknown>; revisions: unknown[] }>('manyfold/get-entry', {
      entryId: postId,
    });
    expect(detail.revisions).toHaveLength(3); // full history kept
    expect(detail.body.body).toBe('First draft.'); // rev 3 == rev 1's body
  });

  it('4. the workflow denials hold — and the neighbouring doors stay open', async () => {
    await sofiaCafe.invoke('manyfold/submit-for-review', { entryId: postId });

    // Author cannot approve or publish…
    await expect(sofiaCafe.invoke('manyfold/approve', { entryId: postId })).rejects.toThrow(/permission denied/);
    await expect(sofiaCafe.invoke('manyfold/publish', { entryId: postId })).rejects.toThrow(/permission denied/);

    // Viewer@law cannot write…
    await expect(
      emilLaw.invoke('manyfold/create-entry', { typeKey: 'page', body: { title: 'X', slug: 'x' } }),
    ).rejects.toThrow(/permission denied/);
    // …but the SAME login CAN read on law (viewer holds content:read) — control.
    // Paged (#1833): a page envelope, not a bare array — see `manyfold/timeline` below.
    const lawEntries = await emilLaw.invoke<Page<unknown>>('manyfold/list-entries', {});
    expect(lawEntries.entries).toBeInstanceOf(Array);

    // Same person, a scope where she holds no role at all → denied even to read.
    await expect(sofiaPadel.invoke('manyfold/list-entries', {})).rejects.toThrow(/permission denied/);

    // Control that the closed door isn't closed for everyone: Emil (publisher@cafe) approves.
    const approved = await emilCafe.invoke<EntryRow>('manyfold/approve', { entryId: postId });
    expect(approved.status).toBe('approved');
  });

  it('5. publish freezes the revision with a verifiable hash and fills the delivery projection', async () => {
    // Attach a reference to a DRAFT snippet first (the unresolved-reference beat).
    const snippet = await emilCafe.invoke<EntryRow>('manyfold/create-entry', {
      typeKey: 'snippet',
      body: { name: 'Hero banner', kind: 'banner', body: 'Big news.' },
    });
    snippetId = snippet.id;
    // The post is 'approved' — to add the ref we take it back to review→draft? No: bodies
    // freeze at publish, so we reference the snippet by editing while still editable. It is
    // 'approved', which does not take new revisions, so publish first, then prove resolution
    // via a second post. Simpler: publish the post as-is.
    const published = await emilCafe.invoke<EntryRow>('manyfold/publish', { entryId: postId });
    expect(published.status).toBe('published');
    expect(published.published_rev).toBe(3);

    const detail = await emilCafe.invoke<{ entry: EntryRow; revisions: { rev_no: number; frozen: number; hash: string | null }[] }>(
      'manyfold/get-entry',
      { entryId: postId },
    );
    const frozen = detail.revisions.find((r) => r.rev_no === 3)!;
    expect(frozen.frozen).toBe(1);
    expect(frozen.hash).toMatch(/^[0-9a-f]{64}$/);

    // Delivery now serves the frozen revision.
    const delivered = await emilCafe.invoke<{ hash: string; body: Record<string, unknown> }>('manyfold/deliver', {
      typeKey: 'post',
      slug: 'hello',
    });
    expect(delivered.hash).toBe(frozen.hash);
    expect(delivered.body.body).toBe('First draft.');
  });

  it('6. immutability + no state-machine skips', async () => {
    // A published entry takes no new revisions.
    await expect(
      emilCafe.invoke('manyfold/save-draft', { entryId: postId, body: { title: 'Hello world', slug: 'hello' } }),
    ).rejects.toThrow(/cannot edit/);

    // publish requires an APPROVED entry — a fresh draft cannot skip straight to published.
    const fresh = await sofiaCafe.invoke<EntryRow>('manyfold/create-entry', {
      typeKey: 'post',
      body: { title: 'Skip', slug: 'skip' },
    });
    // The refusal comes from the declared lifecycle now (#844): the same
    // `invalid transition: …` phrasing every engine uses, naming the operation
    // and the states that would have worked — and it reports the CURRENT state,
    // which the vertical's old hand-written sentence also did but had to repeat.
    await expect(emilCafe.invoke('manyfold/publish', { entryId: fresh.id })).rejects.toThrow(
      /invalid transition: post entry is 'draft', but 'manyfold\/publish' requires approved/,
    );
    // And after submit, still not approved → still blocked (the guard MOVES with state).
    await sofiaCafe.invoke('manyfold/submit-for-review', { entryId: fresh.id });
    await expect(emilCafe.invoke('manyfold/publish', { entryId: fresh.id })).rejects.toThrow(
      /invalid transition: post entry is 'in_review', but 'manyfold\/publish' requires approved/,
    );
  });

  it('7. references resolve at delivery: draft target = unresolved, then resolved once published', async () => {
    // A Page that references the (still draft) snippet in `blocks`.
    const page = await emilCafe.invoke<EntryRow>('manyfold/create-entry', {
      typeKey: 'page',
      body: { title: 'Home', slug: 'home', blocks: [snippetId] },
    });
    await emilCafe.invoke('manyfold/submit-for-review', { entryId: page.id });
    await emilCafe.invoke('manyfold/approve', { entryId: page.id });
    await emilCafe.invoke('manyfold/publish', { entryId: page.id });

    const before = await emilCafe.invoke<{ body: { blocks: { $unresolved?: boolean; reason?: string }[] } }>(
      'manyfold/deliver',
      { typeKey: 'page', slug: 'home' },
    );
    expect(before.body.blocks[0]!.$unresolved).toBe(true);
    expect(before.body.blocks[0]!.reason).toBe('not_published');

    // Publish the snippet, then the same delivery read resolves the link.
    await emilCafe.invoke('manyfold/submit-for-review', { entryId: snippetId });
    await emilCafe.invoke('manyfold/approve', { entryId: snippetId });
    await emilCafe.invoke('manyfold/publish', { entryId: snippetId });

    const after = await emilCafe.invoke<{ body: { blocks: { $ref?: string; title?: string }[] } }>('manyfold/deliver', {
      typeKey: 'page',
      slug: 'home',
    });
    expect(after.body.blocks[0]!.$ref).toBe(snippetId);
    expect(after.body.blocks[0]!.title).toBe('Hero banner');
  });

  it('8. scope isolation: publishing on cafe left padel and law with no delivered content', async () => {
    const majaPadel = await host.getScope(w.maja, w.t1, w.padel);
    const majaLaw = await host.getScope(w.maja, w.t1, w.law);
    // Paged (#1833): grows with every publish, the same as `manyfold/list-entries`.
    await expect(majaPadel.invoke<Page<unknown>>('manyfold/list-delivery', {})).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
    await expect(majaLaw.invoke<Page<unknown>>('manyfold/list-delivery', {})).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
    // cafe has delivered content (the post + the page + the snippet).
    const cafe = await emilCafe.invoke<Page<unknown>>('manyfold/list-delivery', {});
    expect(cafe.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('9. archive removes the entry from delivery; every mutation hit the spine', async () => {
    await emilCafe.invoke('manyfold/archive', { entryId: postId });
    await expect(emilCafe.invoke('manyfold/deliver', { typeKey: 'post', slug: 'hello' })).rejects.toThrow(
      /not published/,
    );
    const status = (await emilCafe.invoke<{ entry: EntryRow }>('manyfold/get-entry', { entryId: postId })).entry.status;
    expect(status).toBe<EntryStatus>('archived');

    // The fat events landed on the spine, in order. A PAGE since #800 — the read
    // is the kernel's `readTimeline`, so an entry edited a hundred times answers
    // with a page rather than a hundred rows.
    const timeline = await emilCafe.invoke<Page<TimelineEntry>>('manyfold/timeline', {
      entityType: 'manyfold-entry',
      entityId: postId,
    });
    expect(timeline.entries.map((e) => e.type)).toEqual([
      'content.submitted',
      'content.approved',
      'content.published',
      'content.archived',
    ]);
  });
});

describe('Manyfold demo scenario — paging under tied timestamps (#1833)', () => {
  it('list-entries walks a cursor across entries that share one instant with no dupes or skips', async () => {
    // A frozen clock, not the wall clock: every entry created below shares the
    // SAME `updated_at`, which is exactly the case an `updated_at`-only cursor
    // gets wrong (skips or repeats the tied rows) — see the (updated_at, id)
    // composite cursor `manyfold/list-entries` declares.
    const clock = manualClock('2026-01-01T00:00:00.000Z');
    const dir = mkdtempSync(join(tmpdir(), 'substrat-manyfold-tie-'));
    const host = buildDemoHost(dir, clock.read);
    try {
      const w = await seedDemo(host, dir);
      // padel, not cafe: `seedDemo` seeds cafe with four starting entries
      // (fresh-instance content), which padel never gets — emil is author@padel.
      const emilPadel = await host.getScope(w.emil, w.t1, w.padel);

      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const entry = await emilPadel.invoke<EntryRow>('manyfold/create-entry', {
          typeKey: 'post',
          body: { title: `Tied ${i}`, slug: `tied-${i}`, body: 'x', category: 'news' },
        });
        ids.push(entry.id);
      }

      const first = await emilPadel.invoke<Page<{ id: string; updated_at: string }>>('manyfold/list-entries', {
        limit: 3,
      });
      expect(first.entries).toHaveLength(3);
      expect(first.entries.every((e) => e.updated_at === clock.now())).toBe(true);
      expect(first.nextCursor).not.toBeNull();

      const seen = [...first.entries];
      let cursor = first.nextCursor;
      while (cursor !== null) {
        const next = await emilPadel.invoke<Page<{ id: string; updated_at: string }>>('manyfold/list-entries', {
          limit: 3,
          cursor,
        });
        seen.push(...next.entries);
        cursor = next.nextCursor;
      }
      // Every entry exactly once — the tied `updated_at` is the whole point.
      expect(seen).toHaveLength(7);
      expect(new Set(seen.map((e) => e.id))).toEqual(new Set(ids));
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list-entries walks an ASCENDING cursor across the same tied timestamps, in order, with no dupes or skips (Copilot #4114802647)', async () => {
    // The descending test above exercises only the declaration's DEFAULT
    // direction. `order: 'asc'` is the restored branch this whole PR is about —
    // a regression there (falling back to the hard-coded 'desc') would pass
    // every other test silently, since 'desc' still answers *something*.
    const clock = manualClock('2026-01-01T00:00:00.000Z');
    const dir = mkdtempSync(join(tmpdir(), 'substrat-manyfold-tie-'));
    const host = buildDemoHost(dir, clock.read);
    try {
      const w = await seedDemo(host, dir);
      const emilPadel = await host.getScope(w.emil, w.t1, w.padel);

      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const entry = await emilPadel.invoke<EntryRow>('manyfold/create-entry', {
          typeKey: 'post',
          body: { title: `Tied asc ${i}`, slug: `tied-asc-${i}`, body: 'x', category: 'news' },
        });
        ids.push(entry.id);
      }
      // ULIDs are monotonic with creation, so ascending id order IS creation order.
      const ascendingIds = [...ids].sort();

      const first = await emilPadel.invoke<Page<{ id: string; updated_at: string }>>('manyfold/list-entries', {
        limit: 3,
        order: 'asc',
      });
      expect(first.entries).toHaveLength(3);
      expect(first.entries.every((e) => e.updated_at === clock.now())).toBe(true);
      expect(first.nextCursor).not.toBeNull();

      // A cursor is only valid for the sort it was issued under (pagination.ts):
      // `order: 'asc'` has to travel on every follow-up request too.
      const seen = [...first.entries];
      let cursor = first.nextCursor;
      while (cursor !== null) {
        const next = await emilPadel.invoke<Page<{ id: string; updated_at: string }>>('manyfold/list-entries', {
          limit: 3,
          cursor,
          order: 'asc',
        });
        seen.push(...next.entries);
        cursor = next.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen.map((e) => e.id))).toEqual(new Set(ids));
      // Order asserted, not just membership: ascending id, the tie-break the
      // declaration's composite cursor walks by.
      expect(seen.map((e) => e.id)).toEqual(ascendingIds);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list-delivery walks a cursor across entries published under one instant with no dupes or skips (Copilot #4114802626)', async () => {
    // Same shape as list-entries' tie test, one operation over: the frozen clock
    // means every publish below shares the same `published_at`, which is exactly
    // the case an unqualified cursor gets wrong.
    const clock = manualClock('2026-01-01T00:00:00.000Z');
    const dir = mkdtempSync(join(tmpdir(), 'substrat-manyfold-tie-'));
    const host = buildDemoHost(dir, clock.read);
    try {
      const w = await seedDemo(host, dir);
      // maja holds `admin` tenant-wide (author + review + publish everywhere),
      // so one principal can carry an entry through the whole lifecycle.
      const majaPadel = await host.getScope(w.maja, w.t1, w.padel);

      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const entry = await majaPadel.invoke<EntryRow>('manyfold/create-entry', {
          typeKey: 'post',
          body: { title: `Tied delivery ${i}`, slug: `tied-delivery-${i}`, body: 'x', category: 'news' },
        });
        await majaPadel.invoke('manyfold/submit-for-review', { entryId: entry.id });
        await majaPadel.invoke('manyfold/approve', { entryId: entry.id });
        await majaPadel.invoke('manyfold/publish', { entryId: entry.id });
        ids.push(entry.id);
      }

      const first = await majaPadel.invoke<Page<{ entry_id: string; published_at: string }>>('manyfold/list-delivery', {
        limit: 3,
      });
      expect(first.entries).toHaveLength(3);
      expect(first.entries.every((e) => e.published_at === clock.now())).toBe(true);
      expect(first.nextCursor).not.toBeNull();

      const seen = [...first.entries];
      let cursor = first.nextCursor;
      while (cursor !== null) {
        const next = await majaPadel.invoke<Page<{ entry_id: string; published_at: string }>>('manyfold/list-delivery', {
          limit: 3,
          cursor,
        });
        seen.push(...next.entries);
        cursor = next.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen.map((e) => e.entry_id))).toEqual(new Set(ids));
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Manyfold demo scenario — CodeRabbit review of PR #1847', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: ManyfoldWorld;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-manyfold-review-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a malformed cursor is refused, not bound into SQL as undefined', async () => {
    const maja = await host.getScope(w.maja, w.t1, w.cafe);
    // No separator at all — the shape a hand-typed or truncated cursor takes,
    // as opposed to one a real `nextCursor` ever produces.
    await expect(maja.invoke('manyfold/list-entries', { cursor: 'not-a-real-cursor' })).rejects.toThrow(
      /invalid cursor/,
    );
    await expect(maja.invoke('manyfold/list-delivery', { cursor: 'not-a-real-cursor' })).rejects.toThrow(
      /invalid cursor/,
    );
  });

  it("list-types defaults to ASCENDING — the declaration names no order, so PagedCommon's own default applies", async () => {
    const maja = await host.getScope(w.maja, w.t1, w.padel); // no seeded types beyond the four defaults
    const page = await maja.invoke<Page<{ key: string }>>('manyfold/list-types', {});
    const keys = page.entries.map((t) => t.key);
    expect(keys).toEqual([...keys].sort());
  });
});
