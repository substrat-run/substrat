import { describe, it, expect } from 'vitest';
import { formatDeclaredModel } from '../src/push.js';
import type { EmittedModel } from '@substrat-run/contracts';

/**
 * The entity model, REPORTED.
 *
 * `readDeclaredModel` has always been able to answer this; nothing ever printed the
 * answer, so a version that shipped without a model said so for the first time in a
 * dashboard panel, after the deploy. These pin the line the push prints instead — in both
 * directions, because the count on a push that carries a model is what makes the note on
 * one that does not read as information rather than noise.
 */
describe('formatDeclaredModel (#1214)', () => {
  const model = (entities: string[], lifecycles: string[] = []): EmittedModel => ({
    entities: Object.fromEntries(
      entities.map((name) => [name, { table: `acme_${name}s`, fields: { type: 'object' } }]),
    ),
    ...(lifecycles.length
      ? {
          lifecycles: Object.fromEntries(
            lifecycles.map((name) => [
              name,
              { field: 'status', initial: 'draft', states: { draft: { terminal: true } } },
            ]),
          ),
        }
      : {}),
  });

  it('counts the entities a model.json carries', () => {
    expect(formatDeclaredModel(model(['customer', 'site']))).toBe('entity model: 2 entities (model.json)');
  });

  it('says "entity" for one, so the line is not written by a machine for a machine', () => {
    expect(formatDeclaredModel(model(['customer']))).toBe('entity model: 1 entity (model.json)');
  });

  it('counts declared lifecycles beside them, and omits the clause when there are none', () => {
    expect(formatDeclaredModel(model(['order'], ['order']))).toBe(
      'entity model: 1 entity, 1 lifecycle (model.json)',
    );
    expect(formatDeclaredModel(model(['order', 'line']))).not.toContain('lifecycle');
  });

  it('is a NOTE when there is none — absence stays legitimate, it just stops being silent', () => {
    const line = formatDeclaredModel(undefined);
    expect(line.startsWith('note: ')).toBe(true);
    expect(line).toContain('no model.json');
    // It names where the fact surfaces otherwise, which is the whole reason the note exists.
    expect(line).toContain('Model');
    expect(line).toContain('substrat model view');
  });
});
