import { describe, it, expect } from 'vitest';
import type { EmittedModel } from '@substrat-run/contracts';
import {
  ConceptMarkerError,
  PermissionsFormatError,
  decisionsLog,
  entityDiagram,
  lifecycleDiagram,
  parsePermissions,
  syncConcept,
} from '../src/index.js';

const MODEL: EmittedModel = {
  entities: {
    list: {
      table: 'todo_lists',
      fields: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, done: { type: 'integer' } } },
      parents: ['owner'],
    },
    item: {
      table: 'todo_items',
      fields: {
        type: 'object',
        properties: { id: { type: 'string' }, list_id: { type: 'string' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      },
      parents: ['list'],
    },
  },
  lifecycles: {
    list: {
      field: 'state',
      initial: 'open',
      states: { open: { on: { 'todo/close': 'closed' } }, closed: { terminal: true } },
    },
  } as EmittedModel['lifecycles'],
};

const PERMISSIONS = `# Permission snapshot

## 1. Registry — every key

| Key | Description | Declared by |
| --- | --- | --- |
| \`list:create\` | Create lists of your own | \`x\` |
| \`list:manage\` | Rename and share a list | \`x\` |

## 2. Roles — as defined

| Role | Permissions |
| --- | --- |
| \`member\` | \`list:create\` |

## 3. Coverage

| Key | Held by |
| --- | --- |
| \`list:create\` | \`member\` |

## 4. Entity-narrowed grant shapes

| Entity type | Permissions granted per entity | Given |
| --- | --- | --- |
| \`list\` | \`list:manage\` | no — shared |
`;

const DOC = `# Concept

## 1. Purpose
Authored.

## 2. Roles
<!-- substrat:roles -->
stale
<!-- /substrat:roles -->

## 3. Entities
<!-- substrat:entities -->
<!-- /substrat:entities -->

## 4. Processes
<!-- substrat:processes -->
<!-- /substrat:processes -->

## 5. Decisions log
- 2026-01-01 first entry
`;

const inputs = { model: MODEL, permissionsMd: PERMISSIONS };

describe('syncConcept', () => {
  it('renders the three regions from the model and the permissions', () => {
    const out = syncConcept(DOC, inputs);
    expect(out).toContain('| `member` | `list:create` — Create lists of your own |');
    expect(out).toContain('| `list` | `list:manage` — Rename and share a list |');
    expect(out).toContain('erDiagram\n    e2 ||--o{ e1 : has\n    e3 ||--o{ e2 : has');
    expect(out).toContain('e1["item"] {');
    expect(out).toContain('        string id PK');
    expect(out).toContain('        number done');
    expect(out).toContain('        string note');
    expect(out).toContain('state "closed" as s1\n    state "open" as s2\n    [*] --> s2\n    s1 --> [*]\n    s2 --> s1 : todo/close');
    expect(out).not.toContain('stale');
  });

  it('is byte-identical on a second run, and leaves authored text alone', () => {
    const once = syncConcept(DOC, inputs);
    expect(syncConcept(once, inputs)).toBe(once);
    expect(once.startsWith('# Concept\n\n## 1. Purpose\nAuthored.\n')).toBe(true);
    expect(once.endsWith('## 5. Decisions log\n- 2026-01-01 first entry\n')).toBe(true);
  });

  it('does not depend on declaration order of entities, fields, roles, keys or grants', () => {
    const wide = `${PERMISSIONS}`
      .replace('| `member` | `list:create` |', '| `member` | `list:manage`, `list:create` |\n| `admin` | `list:manage`, `list:create` |')
      .replace('| `list` | `list:manage` |', '| `owner` | `list:create`, `list:manage` |\n| `list` | `list:manage` |');
    const reversedRoles = wide
      .replace('| `member` | `list:manage`, `list:create` |\n| `admin` | `list:manage`, `list:create` |', '| `admin` | `list:create`, `list:manage` |\n| `member` | `list:create`, `list:manage` |')
      .replace('| `owner` | `list:create`, `list:manage` |\n| `list` | `list:manage` |', '| `list` | `list:manage` |\n| `owner` | `list:manage`, `list:create` |');
    expect(reversedRoles).not.toBe(wide);
    const reversedModel: EmittedModel = {
      ...MODEL,
      entities: {
        item: {
          ...MODEL.entities.item!,
          fields: { type: 'object', properties: Object.fromEntries(Object.entries((MODEL.entities.item!.fields as { properties: object }).properties).reverse()) },
        },
        list: {
          ...MODEL.entities.list!,
          fields: { type: 'object', properties: Object.fromEntries(Object.entries((MODEL.entities.list!.fields as { properties: object }).properties).reverse()) },
        },
      },
    };
    expect(syncConcept(DOC, { model: reversedModel, permissionsMd: reversedRoles })).toBe(
      syncConcept(DOC, { model: MODEL, permissionsMd: wide }),
    );
    expect(syncConcept(DOC, { model: MODEL, permissionsMd: wide })).toContain('| `admin` | `list:create` — Create lists of your own<br>`list:manage`');
  });

  it('draws names Mermaid cannot take as ids through aliases', () => {
    // `in-progress` is a parse error as a bare state id, and a quote would end a label early. Each
    // is checked against mermaid 11's own parser when this was written; a string match here only
    // pins that no raw name reaches an id position.
    const odd: EmittedModel = {
      entities: {
        'my entity': { table: 't', fields: { type: 'object', properties: { id: { type: 'string' }, PK: { type: 'string' } } }, parents: ['own-er'] },
      },
      lifecycles: {
        'my entity': {
          field: 'state',
          initial: 'to-do',
          states: { 'to-do': { on: { 'a/go': 'in progress' } }, 'in progress': { on: { 'a/x': 'say "hi"' } }, 'say "hi"': {} },
        },
      } as EmittedModel['lifecycles'],
    };
    const out = syncConcept(DOC, { model: odd });
    expect(out).toContain('state "in progress" as s1');
    expect(out).toContain('state "say #quot;hi#quot;" as s2');
    expect(out).toContain('state "to-do" as s3');
    expect(out).toContain('[*] --> s3\n    s1 --> s2 : a/x');
    expect(out).toContain('e1["my entity"] {');
    expect(out).toContain('e2 ||--o{ e1 : has');
    expect(out).toContain('e2["own-er"] {');
    expect(out).toContain('string PK_ "PK"');
    expect(out).not.toMatch(/^ {4}(to-do|in-progress|own-er)\b/m);
  });

  it('gives colliding and non-ASCII field names distinct ids, with the real name as the comment', () => {
    const fields = ['with-dash', 'with_dash', 'PK', 'PK_', 'größe', '1st', 'id'];
    const m: EmittedModel = {
      entities: { t: { table: 't', fields: { type: 'object', properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])) } } },
    };
    const out = syncConcept(DOC, { model: m });
    const attrs = [...out.matchAll(/^ {8}string (\S+)(?: PK)?(?: "(.*)")?$/gm)].map((x) => [x[1], x[2]]);
    expect(new Set(attrs.map((a) => a[0])).size).toBe(fields.length);
    expect(Object.fromEntries(attrs.map(([id, real]) => [real ?? id, id]))).toEqual({
      '1st': 'f_1st',
      PK: 'PK__2',
      PK_: 'PK_',
      id: 'id',
      'with-dash': 'with_dash_2',
      with_dash: 'with_dash',
      größe: 'gr__e',
    });
  });

  it('goes stale when the model changes — a new field changes the output', () => {
    const fresh = syncConcept(DOC, inputs);
    const grown: EmittedModel = {
      ...MODEL,
      entities: {
        ...MODEL.entities,
        list: {
          ...MODEL.entities.list!,
          fields: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } } },
        },
      },
    };
    expect(syncConcept(fresh, { ...inputs, model: grown })).not.toBe(fresh);
  });

  it('goes stale when a role gains a key', () => {
    const fresh = syncConcept(DOC, inputs);
    const widened = PERMISSIONS.replace('| `member` | `list:create` |', '| `member` | `list:create`, `list:manage` |');
    expect(syncConcept(fresh, { ...inputs, permissionsMd: widened })).not.toBe(fresh);
  });

  it('says so when there is nothing to draw', () => {
    const out = syncConcept(DOC, { model: { entities: {} } });
    expect(out).toContain('No `PERMISSIONS.md` beside');
    expect(out).toContain('No entities are declared');
    expect(out).toContain('No lifecycle is declared');
  });

  it('refuses a missing, doubled or unclosed marker rather than skipping it', () => {
    expect(() => syncConcept(DOC.replace('<!-- substrat:entities -->', ''), inputs)).toThrow(ConceptMarkerError);
    expect(() => syncConcept(DOC.replace('<!-- /substrat:processes -->', ''), inputs)).toThrow(/never closed/);
    expect(() => syncConcept(`${DOC}\n<!-- substrat:roles -->`, inputs)).toThrow(/more than once/);
  });
});

describe('parsePermissions / decisionsLog', () => {
  it('reads roles, grant shapes and descriptions', () => {
    const v = parsePermissions(PERMISSIONS);
    expect(v.roles).toEqual([{ role: 'member', keys: ['list:create'] }]);
    expect(v.entityGrants).toEqual([{ entityType: 'list', keys: ['list:manage'] }]);
    expect(v.descriptions.get('list:manage')).toBe('Rename and share a list');
  });

  it('finds the grant shapes by title, not number: schedules and no grants is not a grant table', () => {
    // permission-diff numbers every section after §3 by which ones the vertical has, so here §4 is
    // the schedules. Read by the literal "## 4." this rendered them as an entity-grant row.
    const withSchedules = PERMISSIONS.replace(
      /## 4\. Entity-narrowed grant shapes[\s\S]*$/,
      '## 4. Scheduled work — the system principal\'s grants\n\n| Operation | Cadence | System principal | Permissions |\n| --- | --- | --- | --- |\n| `todo/purge` — purges | every 60 min | `system:x` | `list:manage` |\n',
    );
    const v = parsePermissions(withSchedules);
    expect(v.entityGrants).toEqual([]);
    expect(v.roles).toEqual([{ role: 'member', keys: ['list:create'] }]);
    expect(syncConcept(DOC, { model: MODEL, permissionsMd: withSchedules })).not.toContain('Shared one record at a time');
  });

  it('finds the grant shapes when they come later, and still reads the roles before them', () => {
    const later = PERMISSIONS.replace('## 4. Entity-narrowed', '## 6. Entity-narrowed');
    expect(parsePermissions(later).entityGrants).toEqual([{ entityType: 'list', keys: ['list:manage'] }]);
  });

  it('refuses a file whose registry or roles section is gone, but not an empty permission surface', () => {
    expect(() => parsePermissions(PERMISSIONS.replace('## 2. Roles', '## 2. People'))).toThrow(PermissionsFormatError);
    expect(() => parsePermissions('# P\n\n## No permission surface\n')).not.toThrow();
  });

  it('finds the decisions log section, numbered or not', () => {
    expect(decisionsLog(DOC)).toBe('- 2026-01-01 first entry\n');
    expect(decisionsLog('# x\n\n## Decisions log\nA\n## Next\nB')).toBe('A');
    expect(decisionsLog('# x')).toBeUndefined();
  });
});

describe('entityDiagram / lifecycleDiagram', () => {
  it('are the generated regions themselves, so `substrat plan` draws what concept.md draws', () => {
    const synced = syncConcept(DOC, inputs);
    expect(synced).toContain(`<!-- substrat:entities -->\n\n${entityDiagram(MODEL)}\n\n<!-- /substrat:entities -->`);
    expect(synced).toContain(lifecycleDiagram('list', MODEL.lifecycles!.list!));
  });
});
