import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
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
      expect(versions.map((v) => v.version)).toEqual(['0001-init', '0002-content-types']);
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

  it('1b. modelling: an admin creates a content type; it drives create-entry immediately', async () => {
    const maja = await host.getScope(w.maja, w.t1, w.cafe); // admin@cafe
    // The four defaults are seeded lazily on first use.
    const types = await maja.invoke<{ def: { key: string } }[]>('manyfold/list-types');
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
    await expect(emilLaw.invoke('manyfold/list-entries', {})).resolves.toBeInstanceOf(Array);

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
    await expect(emilCafe.invoke('manyfold/publish', { entryId: fresh.id })).rejects.toThrow(
      /publish requires an approved entry/,
    );
    // And after submit, still not approved → still blocked (the guard MOVES with state).
    await sofiaCafe.invoke('manyfold/submit-for-review', { entryId: fresh.id });
    await expect(emilCafe.invoke('manyfold/publish', { entryId: fresh.id })).rejects.toThrow(
      /publish requires an approved entry/,
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
    await expect(majaPadel.invoke<unknown[]>('manyfold/list-delivery', {})).resolves.toEqual([]);
    await expect(majaLaw.invoke<unknown[]>('manyfold/list-delivery', {})).resolves.toEqual([]);
    // cafe has delivered content (the post + the page + the snippet).
    const cafe = await emilCafe.invoke<unknown[]>('manyfold/list-delivery', {});
    expect(cafe.length).toBeGreaterThanOrEqual(2);
  });

  it('9. archive removes the entry from delivery; every mutation hit the spine', async () => {
    await emilCafe.invoke('manyfold/archive', { entryId: postId });
    await expect(emilCafe.invoke('manyfold/deliver', { typeKey: 'post', slug: 'hello' })).rejects.toThrow(
      /not published/,
    );
    const status = (await emilCafe.invoke<{ entry: EntryRow }>('manyfold/get-entry', { entryId: postId })).entry.status;
    expect(status).toBe<EntryStatus>('archived');

    // The fat events landed on the spine, in order.
    const timeline = await emilCafe.invoke<{ type: string }[]>('manyfold/timeline', {
      entityType: 'manyfold-entry',
      entityId: postId,
    });
    expect(timeline.map((e) => e.type)).toEqual([
      'content.submitted',
      'content.approved',
      'content.published',
      'content.archived',
    ]);
  });
});
