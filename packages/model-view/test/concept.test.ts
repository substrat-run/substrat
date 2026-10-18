import { describe, it, expect } from 'vitest';
import type { EmittedModel } from '@substrat-run/contracts';
import { ConceptMarkerError, decisionsLog, parsePermissions, syncConcept } from '../src/index.js';

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
    expect(out).toContain('erDiagram\n    list ||--o{ item : has\n    owner ||--o{ list : has');
    expect(out).toContain('        string id PK');
    expect(out).toContain('        number done');
    expect(out).toContain('        string note');
    expect(out).toContain('    [*] --> open\n    closed --> [*]\n    open --> closed : todo/close');
    expect(out).not.toContain('stale');
  });

  it('is byte-identical on a second run, and leaves authored text alone', () => {
    const once = syncConcept(DOC, inputs);
    expect(syncConcept(once, inputs)).toBe(once);
    expect(once.startsWith('# Concept\n\n## 1. Purpose\nAuthored.\n')).toBe(true);
    expect(once.endsWith('## 5. Decisions log\n- 2026-01-01 first entry\n')).toBe(true);
  });

  it('does not depend on declaration order', () => {
    const reordered: EmittedModel = { ...MODEL, entities: { item: MODEL.entities.item!, list: MODEL.entities.list! } };
    expect(syncConcept(DOC, { ...inputs, model: reordered })).toBe(syncConcept(DOC, inputs));
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
    expect(out).toContain('No `PERMISSIONS.md` yet');
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

  it('finds the decisions log section, numbered or not', () => {
    expect(decisionsLog(DOC)).toBe('- 2026-01-01 first entry\n');
    expect(decisionsLog('# x\n\n## Decisions log\nA\n## Next\nB')).toBe('A');
    expect(decisionsLog('# x')).toBeUndefined();
  });
});
