import { describe, expect, it } from 'vitest';
import type { EmittedModel } from '@substrat-run/contracts';
import { declaredProcesses, isProcessPeriod, processWindows } from '../src/process-map.js';

/** The process map's windows and its list of declared lifecycles (#1744). */
describe('processWindows', () => {
  it('compares the period asked with the equal one just before it, half-open', () => {
    const now = Date.parse('2026-09-28T12:00:00.000Z');
    expect(processWindows('24h', now)).toEqual({
      current: { since: '2026-09-27T12:00:00.000Z', until: '2026-09-28T12:00:00.000Z' },
      previous: { since: '2026-09-26T12:00:00.000Z', until: '2026-09-27T12:00:00.000Z' },
    });
    // The windows meet exactly: nothing is counted in both, nothing falls between.
    const w = processWindows('7d', now);
    expect(w.previous.until).toBe(w.current.since);
  });

  it('knows only the three periods the screen offers', () => {
    expect(['24h', '7d', '30d'].every(isProcessPeriod)).toBe(true);
    expect(isProcessPeriod('1y')).toBe(false);
    expect(isProcessPeriod('toString')).toBe(false);
  });
});

describe('declaredProcesses', () => {
  it('lists each declared lifecycle with the size of its machine, by entity', () => {
    const model = {
      entities: {},
      lifecycles: {
        order: { field: 'status', initial: 'draft', states: { draft: { on: { 'o/send': 'sent' } }, sent: { terminal: true } } },
        conversation: {
          field: 'state',
          initial: 'new',
          states: { new: { on: { 'c/open': 'open', 'c/close': 'closed' } }, open: { on: { 'c/close': 'closed' } }, closed: { terminal: true } },
        },
      },
    } as unknown as EmittedModel;
    expect(declaredProcesses(model)).toEqual([
      { entity: 'conversation', initial: 'new', states: 3, edges: 3 },
      { entity: 'order', initial: 'draft', states: 2, edges: 1 },
    ]);
  });

  it('is empty for no model, or one that declares no lifecycle', () => {
    expect(declaredProcesses(null)).toEqual([]);
    expect(declaredProcesses({ entities: {} } as EmittedModel)).toEqual([]);
  });
});
