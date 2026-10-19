import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendDecision, conceptDelta, digestOf, entryFor, entryTextProblem, isEmpty, planCommand, renderDelta } from '../src/plan.js';

/**
 * `substrat plan` (#2363): the concept delta a design gate shows, and the approval that records it.
 * Every section of the delta has its twin — an unchanged tree says, in that section, that nothing
 * moved — because a section that renders nothing when nothing changed reads the same as one that
 * forgot to look.
 */

const PKG = '@acme/vertical';
const fields = (props: Record<string, unknown>, required: string[] = ['id']) => ({ type: 'object', properties: props, required });

const MODEL = {
  entities: {
    list: { table: 'lists', fields: fields({ id: { type: 'string' }, name: { type: 'string' } }) },
    item: {
      table: 'items',
      parents: ['list'],
      fields: fields({ id: { type: 'string' }, state: { type: 'string', enum: ['open', 'done'] } }),
    },
  },
  lifecycles: {
    item: { field: 'state', initial: 'open', states: { open: { on: { 'acme/finish': 'done' } }, done: { terminal: true } } },
  },
};

const permissions = (roles: Record<string, string[]>, keys: Record<string, string> = { 'list:create': 'Create lists', 'list:manage': 'Manage a list' }) =>
  [
    '## 1. Registry — every key a registered manifest declares',
    '',
    '| Key | Description | Declared by |',
    '| --- | --- | --- |',
    ...Object.entries(keys).map(([k, d]) => `| \`${k}\` | ${d} | \`${PKG}\` |`),
    '',
    '## 2. Roles — as defined by this vertical\'s provisioning code',
    '',
    '| Role | Permissions |',
    '| --- | --- |',
    ...Object.entries(roles).map(([r, ks]) => `| \`${r}\` | ${ks.map((k) => `\`${k}\``).join(', ')} |`),
    '',
  ].join('\n');

const PERMS = permissions({ member: ['list:create'], owner: ['list:create', 'list:manage'] });
const art = (model: unknown, perms: string | null = PERMS) => ({ model: model === null ? null : JSON.stringify(model, null, 2), openapi: null, permissions: perms });
const clone = (): any => structuredClone(MODEL);
const OPTS = { base: 'main', digest: 'abc123', date: '2026-10-18' };

describe('conceptDelta — each section, and its twin when nothing changed', () => {
  const same = conceptDelta(PKG, art(MODEL), art(MODEL));
  const sameText = renderDelta(same, OPTS);

  it('entities: added, removed and changed, with the model before and after', () => {
    const head = clone();
    head.entities.tag = { table: 'tags', fields: fields({ id: { type: 'string' } }) };
    head.entities.list.fields.properties.colour = { type: 'string' };
    delete head.entities.item;
    delete head.lifecycles.item;
    const d = conceptDelta(PKG, art(MODEL), art(head));
    expect(d.entities.added).toEqual(['tag']);
    expect(d.entities.removed).toEqual(['item']);
    expect(d.entities.changed.map((c) => c.entity)).toEqual(['list']);
    expect(d.entities.changed[0]!.changes).toEqual([expect.objectContaining({ path: 'entities.list.fields.colour', detail: 'added' })]);
    // The concept generator's own diagram on both sides: `item` only before, `tag` only after.
    expect(d.entities.before).toContain('erDiagram');
    expect(d.entities.before).toContain('"item"');
    expect(d.entities.after).not.toContain('"item"');
    expect(d.entities.after).toContain('"tag"');
    const text = renderDelta(d, OPTS);
    expect(text).toContain('- **Added:** `tag`');
    expect(text).toContain('- **Removed:** `item`');
    expect(text).toContain('### Before');
  });

  it('entities twin: an unchanged model says so and draws nothing', () => {
    expect(same.entities).toMatchObject({ added: [], removed: [], changed: [], before: null, after: '' });
    expect(sameText).toContain('_No entity is added, changed or removed._');
    expect(sameText).not.toContain('erDiagram');
  });

  it('a base with no model draws "every entity is new" rather than an empty before', () => {
    const d = conceptDelta(PKG, art(null, null), art(MODEL));
    expect(d.entities.added).toEqual(['item', 'list']);
    expect(renderDelta(d, OPTS)).toContain('_No model at the base: every entity is new._');
  });

  it('lifecycles: states and transitions, each with the operation that triggers it', () => {
    const head = clone();
    head.entities.item.fields.properties.state.enum = ['open', 'done', 'cancelled'];
    head.lifecycles.item.states.open.on['acme/cancel'] = 'cancelled';
    head.lifecycles.item.states.cancelled = { terminal: true };
    const d = conceptDelta(PKG, art(MODEL), art(head));
    expect(d.lifecycles.transitions).toEqual([{ entity: 'item', from: 'open', operation: 'acme/cancel', to: 'cancelled', change: 'added' }]);
    expect(d.lifecycles.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'lifecycles.item.states.cancelled', detail: 'state added' })]),
    );
    expect(d.lifecycles.after).toHaveLength(1);
    const text = renderDelta(d, OPTS);
    // This PERMISSIONS.md has no Operations section, so no key is named — and none is guessed.
    expect(text).toContain('| `item` | `open` | `acme/cancel` | `cancelled` | added | — not in PERMISSIONS.md — |');
    expect(text).toContain('that file predates its Operations section');
    expect(text).toContain('stateDiagram-v2');
  });

  // #2384: the key each transition's operation checks, and who holds it, from the Operations section.
  const withOps = (md: string, rows: string[]) =>
    [
      md,
      '## 4. Entity-narrowed grant shapes',
      '',
      '| Entity type | Permissions granted per entity |',
      '| --- | --- |',
      '| `list` | `list:manage` |',
      '',
      '## 5. Operations — which key each checks',
      '',
      '| Operation | Key | Checked on | Declared by |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
  const cancelled = () => {
    const head = clone();
    head.entities.item.fields.properties.state.enum = ['open', 'done', 'cancelled'];
    head.lifecycles.item.states.open.on['acme/cancel'] = 'cancelled';
    head.lifecycles.item.states.cancelled = { terminal: true };
    return head;
  };

  it('lifecycles: each transition names the key its operation declares, and the roles and grant shapes holding it', () => {
    const md = withOps(PERMS, [`| \`acme/cancel\` | \`list:manage\` | one \`list\`, resolved in the handler | \`${PKG}\` |`]);
    const d = conceptDelta(PKG, art(MODEL, md), art(cancelled(), md));
    expect(d.lifecycles.transitions[0]!.check).toEqual({
      declared: true,
      keys: ['list:manage'],
      checkedOn: 'one `list`, resolved in the handler',
      roles: ['owner'],
      grantShapes: ['list'],
    });
    const text = renderDelta(d, OPTS);
    expect(text).toContain('| added | `list:manage` on one `list`, resolved in the handler — roles `owner`; per record on `list` |');
    expect(text).not.toContain('predates its Operations section');
    expect(text).not.toContain('not in the artifacts');
  });

  it('its twin: an operation that declares nothing is said to be checked in code — no key is guessed', () => {
    const md = withOps(PERMS, [`| \`acme/cancel\` | — checked in code, not declared — | — | \`${PKG}\` |`]);
    const d = conceptDelta(PKG, art(MODEL, md), art(cancelled(), md));
    expect(d.lifecycles.transitions[0]!.check).toMatchObject({ declared: false, keys: [] });
    const text = renderDelta(d, OPTS);
    expect(text).toContain('| added | checked in code, not declared |');
    expect(text).toContain('declares none, so no artifact names its key');
  });

  it('an Operations table the classifier cannot read is shown as unreadable — never as "not listed"', () => {
    const md = withOps(PERMS, ['| `acme/cancel` | `list:manage` | `@acme/vertical` |']);
    const d = conceptDelta(PKG, art(MODEL, md), art(cancelled(), md));
    expect(d.lifecycles.transitions[0]).toMatchObject({ checkUnreadable: expect.stringMatching(/cells/) });
    expect(d.lifecycles.transitions[0]!.check).toBeUndefined();
    const text = renderDelta(d, OPTS);
    expect(text).toContain('| added | — unreadable: the Operations table is not the emitter’s — |');
    expect(text).toContain('The Operations section of PERMISSIONS.md cannot be read');
    expect(text).not.toContain('predates its Operations section');
  });

  it('a bare module\'s operations are named as unknown — the cause, not the file\'s age', () => {
    const md = withOps(PERMS, [`| \`acme/other\` | \`list:create\` | the scope | \`${PKG}\` |`]).replace(
      /\n$/,
      '\nOperations not readable for `@acme/bare`: registered as a bare manifest, so its operations are not known here.\n',
    );
    const d = conceptDelta(PKG, art(MODEL, md), art(cancelled(), md));
    expect(d.lifecycles.transitions[0]).toMatchObject({ operationsUnknownFor: ['@acme/bare'] });
    const text = renderDelta(d, OPTS);
    expect(text).toContain('| added | — not listed: operations unknown for `@acme/bare` — |');
    expect(text).toContain('Operations unknown for `@acme/bare`: registered as a bare manifest');
    expect(text).not.toContain('predates its Operations section');
  });

  it('a removed transition reads its check at the base, where the operation still existed', () => {
    const base = withOps(PERMS, [`| \`acme/finish\` | \`list:create\` | the scope | \`${PKG}\` |`]);
    const head = withOps(PERMS, []);
    const gone = clone();
    gone.lifecycles.item.states.open = {};
    const d = conceptDelta(PKG, art(MODEL, base), art(gone, head));
    expect(d.lifecycles.transitions[0]).toMatchObject({ change: 'removed', check: { keys: ['list:create'], roles: ['member', 'owner'] } });
  });

  it('lifecycles: a retargeted and a removed transition are told apart', () => {
    const head = clone();
    head.lifecycles.item.states.open.on = { 'acme/finish': 'open' };
    const d = conceptDelta(PKG, art(MODEL), art(head));
    expect(d.lifecycles.transitions).toEqual([
      { entity: 'item', from: 'open', operation: 'acme/finish', to: 'open', change: 'retargeted', was: 'done' },
    ]);
    const gone = clone();
    gone.lifecycles.item.states.open = {};
    expect(conceptDelta(PKG, art(MODEL), art(gone)).lifecycles.transitions).toEqual([
      { entity: 'item', from: 'open', operation: 'acme/finish', to: 'done', change: 'removed' },
    ]);
  });

  it('a base with no model draws each lifecycle as added, with its state diagram', () => {
    const d = conceptDelta(PKG, art(null, null), art(MODEL));
    expect(d.lifecycles.added).toEqual(['item']);
    expect(d.lifecycles.after).toHaveLength(1);
    expect(d.lifecycles.after[0]).toContain('stateDiagram-v2');
    const text = renderDelta(d, OPTS);
    expect(text).toContain('- **Lifecycle added:** `item`');
    expect(text).toContain('stateDiagram-v2');
  });

  it('lifecycles twin: unchanged lifecycles say so', () => {
    expect(same.lifecycles).toMatchObject({ added: [], removed: [], transitions: [], changes: [], after: [] });
    expect(sameText).toContain('_No lifecycle, state or transition changes._');
  });

  it('permissions: the permission-diff table, key → description → roles before and after', () => {
    const head = permissions(
      { member: ['list:create', 'list:share'], owner: ['list:create', 'list:manage', 'list:share'] },
      { 'list:create': 'Create lists', 'list:manage': 'Manage a list', 'list:share': 'Share a list' },
    );
    const d = conceptDelta(PKG, art(MODEL), art(MODEL, head));
    expect(d.permissions.rows).toEqual([{ key: 'list:share', description: 'Share a list', before: null, after: ['member', 'owner'] }]);
    expect(d.permissions.changes.every((c) => c.flagged)).toBe(true);
    const text = renderDelta(d, OPTS);
    expect(text).toContain('| `list:share` | Share a list | — (no such key) | `member`, `owner` |');
    expect(text).toContain('**Review:**');
  });

  it('permissions: a key changing holders is a row too', () => {
    const head = permissions({ member: ['list:create', 'list:manage'], owner: ['list:create', 'list:manage'] });
    const d = conceptDelta(PKG, art(MODEL), art(MODEL, head));
    expect(d.permissions.rows).toEqual([{ key: 'list:manage', description: 'Manage a list', before: ['owner'], after: ['member', 'owner'] }]);
  });

  it('permissions twin: unchanged permissions say so', () => {
    expect(same.permissions).toEqual({ rows: [], changes: [] });
    expect(sameText).toContain('_No permission key, role or grant shape changes._');
  });

  it('spec impact: the changeset classifier’s bump, with the changes that set it', () => {
    const head = clone();
    delete head.entities.list.fields.properties.name;
    const d = conceptDelta(PKG, art(MODEL), art(head));
    expect(d.impact.bump).toBe('major');
    const text = renderDelta(d, OPTS);
    expect(text).toContain('**major**');
    expect(text).toContain('`entities.list.fields.name` (model): removed — major');
  });

  it('spec impact twin: none, said aloud', () => {
    expect(same.impact).toEqual({ bump: 'none', changes: [] });
    expect(sameText).toContain('**none** — nothing a caller sends or reads, and no permission, changed.');
  });

  it('the proposed entry names what moved and the bump; its twin has nothing to approve', () => {
    const head = clone();
    head.entities.tag = { table: 'tags', fields: fields({ id: { type: 'string' } }) };
    const d = conceptDelta(PKG, art(MODEL), art(head));
    const entry = entryFor(d, { date: '2026-10-18', digest: 'abc123', why: 'Owners asked to tag items', by: 'the owner' });
    expect(entry).toMatch(/^- 2026-10-18: Owners asked to tag items\. Entities: added `tag`\./);
    expect(entry).toContain('Spec impact: minor.');
    expect(entry.replace(/\s+/g, ' ')).toContain('Approved by the owner at the design gate (`substrat plan` abc123).');
    for (const line of entry.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    expect(entryFor(d, { date: '2026-10-18', digest: 'abc123' })).toContain('<why, in the owner’s words>.');
    expect(isEmpty(same)).toBe(true);
    expect(sameText).toContain('_Nothing to approve: the artifacts are the same as at the base._');
  });
});

describe('determinism', () => {
  it('the same trees give the same text and digest; a different tree a different digest', async () => {
    const head = clone();
    head.entities.tag = { table: 'tags', fields: fields({ id: { type: 'string' } }) };
    const a = conceptDelta(PKG, art(MODEL), art(head));
    const b = conceptDelta(PKG, art(MODEL), art(head));
    expect(renderDelta(a, OPTS)).toBe(renderDelta(b, OPTS));
    expect(await digestOf(a)).toBe(await digestOf(b));
    expect(await digestOf(a)).toMatch(/^[0-9a-f]{12}$/);
    head.entities.tag.fields.properties.label = { type: 'string' };
    expect(await digestOf(conceptDelta(PKG, art(MODEL), art(head)))).not.toBe(await digestOf(a));
  });
});

describe('entryTextProblem', () => {
  it('refuses comments, line breaks and control characters; passes plain text', () => {
    for (const bad of ['a <!-- b', 'b --> c', 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
      expect(entryTextProblem(bad), JSON.stringify(bad)).toBeDefined();
    }
    for (const good of [undefined, 'Owners asked to tag items', 'Ada Lovelace — owner', 'a -> b, a < b']) {
      expect(entryTextProblem(good), JSON.stringify(good)).toBeUndefined();
    }
  });
});

describe('appendDecision', () => {
  it('adds the entry as the last item of the log, keeping the section after it', () => {
    const md = '# C\n\n## Decisions log\n\n- 2026-01-01: first.\n\n## Later\n\ntext\n';
    expect(appendDecision(md, '- new.')).toBe('# C\n\n## Decisions log\n\n- 2026-01-01: first.\n- new.\n\n## Later\n\ntext\n');
  });

  it('writes into an empty log at the end of the file', () => {
    expect(appendDecision('# C\n\n## Decisions log\n', '- new.')).toBe('# C\n\n## Decisions log\n\n- new.\n');
  });

  it('refuses a document with no log, rather than writing the approval elsewhere', () => {
    expect(() => appendDecision('# C\n\n## Other\n', '- new.')).toThrow(/no "Decisions log" section/);
  });
});

describe('planCommand against a git checkout', () => {
  let repo: string;
  let pkgDir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const CONCEPT = [
    '# Acme',
    '',
    '<!-- substrat:roles -->',
    '<!-- /substrat:roles -->',
    '<!-- substrat:entities -->',
    '<!-- /substrat:entities -->',
    '<!-- substrat:processes -->',
    '<!-- /substrat:processes -->',
    '',
    '## Decisions log',
    '',
    '- 2026-01-01: The first design.',
    '',
  ].join('\n');
  const DATE = '2026-10-18';

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'substrat-plan-'));
    pkgDir = join(repo, 'verticals', 'acme');
    mkdirSync(join(pkgDir, 'spec'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version: '0.1.0' }));
    writeFileSync(join(pkgDir, 'model.json'), JSON.stringify(MODEL, null, 2));
    writeFileSync(join(pkgDir, 'PERMISSIONS.md'), PERMS);
    writeFileSync(join(pkgDir, 'spec', 'concept.md'), CONCEPT);
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const addTag = (label = false) => {
    const m = clone();
    m.entities.tag = { table: 'tags', fields: fields({ id: { type: 'string' }, ...(label ? { label: { type: 'string' } } : {}) }) };
    writeFileSync(join(pkgDir, 'model.json'), JSON.stringify(m, null, 2));
  };
  const concept = () => readFileSync(join(pkgDir, 'spec', 'concept.md'), 'utf8');

  it('renders the delta, and --json carries the same delta with its digest and entry', async () => {
    addTag();
    const text = await planCommand(pkgDir, { base: 'main', json: false, date: DATE });
    expect(text.out[0]).toContain('# Concept delta — @acme/vertical');
    const json = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    expect(json).toMatchObject({ base: 'main', package: PKG, entities: { added: ['tag'] }, impact: { bump: 'minor' } });
    expect(text.out[0]).toContain(`Digest \`${json.digest}\``);
    expect(json.entry).toContain('Entities: added `tag`.');
  });

  it('--json twin: an unchanged tree has no entry to propose', async () => {
    const json = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    expect(json.entry).toBeNull();
    expect(json.impact.bump).toBe('none');
  });

  it('--approve with the shown digest records the entry and re-syncs the generated sections', async () => {
    addTag();
    const { digest } = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    const r = await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by: 'the owner', why: 'Tags were asked for' });
    expect(r.code).toBe(0);
    const doc = concept();
    expect(doc).toContain(`- 2026-01-01: The first design.\n- ${DATE}: Tags were asked for. Entities: added \`tag\`.`);
    expect(doc.replace(/\s+/g, ' ')).toContain(`Approved by the owner at the design gate (\`substrat plan\` ${digest}).`);
    expect(doc).toContain('erDiagram'); // the generated region, synced
  });

  it('--approve with a digest the tree no longer has is refused, and writes nothing', async () => {
    addTag();
    const { digest } = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    addTag(true); // the model moved after it was shown
    const r = await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by: 'the owner', why: 'Tags' });
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/not the .* that was approved/);
    expect(concept()).toBe(CONCEPT);
  });

  it('--approve needs who and why, and an empty delta has nothing to approve', async () => {
    addTag();
    const { digest } = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    expect((await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, why: 'x' })).code).toBe(1);
    expect((await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by: 'x' })).code).toBe(1);
    writeFileSync(join(pkgDir, 'model.json'), JSON.stringify(MODEL, null, 2));
    const empty = await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by: 'x', why: 'y' });
    expect(empty.code).toBe(1);
    expect(empty.err[0]).toMatch(/nothing to approve/);
    expect(concept()).toBe(CONCEPT);
  });

  it('a concept marker in --why or --by is refused, and concept.md stays byte-identical', async () => {
    addTag();
    const { digest } = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    for (const [why, by] of [
      ['x <!-- substrat:entities --> y', 'Ada'],
      ['Tags', 'Ada -->'],
      ['Tags', '<!-- /substrat:roles -->'],
    ]) {
      const r = await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by, why });
      expect(r.code, `${why} / ${by}`).toBe(1);
      expect(r.err[0]).toMatch(/may not contain an HTML comment/);
      expect(concept()).toBe(CONCEPT);
    }
    // The twin: the same approval with plain text goes through, and the file still syncs.
    const ok = await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by: 'Ada', why: 'Tags' });
    expect(ok.code).toBe(0);
    expect(concept()).toContain('Tags. Entities: added `tag`.');
  });

  it('a multi-line --why is refused, and concept.md stays byte-identical', async () => {
    addTag();
    const { digest } = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    const r = await planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by: 'Ada', why: 'one\n## Injected' });
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/must be one line of plain text/);
    expect(concept()).toBe(CONCEPT);
  });

  it('a concept document whose markers cannot be read refuses before anything is written', async () => {
    addTag();
    const broken = CONCEPT.replace('<!-- /substrat:roles -->\n', '');
    writeFileSync(join(pkgDir, 'spec', 'concept.md'), broken);
    const { digest } = JSON.parse((await planCommand(pkgDir, { base: 'main', json: true, date: DATE })).out[0]!);
    await expect(planCommand(pkgDir, { base: 'main', json: false, date: DATE, approve: digest, by: 'x', why: 'y' })).rejects.toThrow(/never closed/);
    expect(concept()).toBe(broken);
  });

  it('without --base it falls back to main when the project has no changesets config', async () => {
    addTag();
    const json = JSON.parse((await planCommand(pkgDir, { json: true, date: DATE })).out[0]!);
    expect(json.base).toBe('main');
  });
});
