/**
 * #680 — the model phase, and the direction rule made mechanical.
 *
 * The guards are the point. A phase ladder that only *asks* the model to stay in
 * its lane is a prompt hope; these refuse.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContext,
  buildWriteGuard,
  detectPhase,
  interviewWriteGuard,
  isSpecPhase,
  modelWriteGuard,
  PHASES,
} from '../src/phase.js';

/** A workspace that exists exactly where told to. */
const ws = (...present: string[]) => ({ exists: async (p: string) => present.includes(p) });

describe('the ladder', () => {
  it('interview until a concept lands', async () => {
    expect(await detectPhase(ws())).toBe('interview');
  });

  it('model once the concept is approved and no model exists', async () => {
    expect(await detectPhase(ws('spec/concept.md'))).toBe('model');
  });

  it('scaffold once the model lands', async () => {
    expect(await detectPhase(ws('spec/concept.md', 'spec/model.ts'))).toBe('scaffold');
  });

  it('iterate once the module exists', async () => {
    expect(await detectPhase(ws('spec/concept.md', 'spec/model.ts', 'src/module.ts'))).toBe('iterate');
  });

  it('is ordered, so a UI stepper can render it', () => {
    expect(PHASES).toEqual(['interview', 'model', 'scaffold', 'iterate']);
  });

  it('knows which phases write the spec', () => {
    expect(isSpecPhase('interview')).toBe(true);
    expect(isSpecPhase('model')).toBe(true);
    expect(isSpecPhase('scaffold')).toBe(false);
    expect(isSpecPhase('iterate')).toBe(false);
  });
});

describe('spec-phase guards write only spec/**', () => {
  for (const [name, guard] of [
    ['interview', interviewWriteGuard],
    ['model', modelWriteGuard],
  ] as const) {
    it(`${name} allows spec/, refuses code`, () => {
      expect(guard('spec/concept.md')).toBeNull();
      expect(guard('spec/model.ts')).toBeNull();
      expect(guard('./spec/model.ts')).toBeNull();
      expect(guard('src/module.ts')).toContain('spec/**');
      expect(guard('package.json')).not.toBeNull();
    });
  }
});

describe('the direction rule — build turns cannot author the model', () => {
  it('refuses spec/model.*', () => {
    // Downstream may FALSIFY the model; it may not AUTHOR it. Without this a
    // failing build can redraw the contract until everything agrees again.
    expect(buildWriteGuard('spec/model.ts')).toContain('only from');
    expect(buildWriteGuard('./spec/model.ts')).not.toBeNull();
    expect(buildWriteGuard('spec/model.json')).not.toBeNull();
  });

  it('tells the model to STOP rather than work around a wrong model', () => {
    expect(buildWriteGuard('spec/model.ts')).toMatch(/stop/i);
  });

  it('allows everything else — it is a mirror, not a cage', () => {
    expect(buildWriteGuard('src/module.ts')).toBeNull();
    expect(buildWriteGuard('spec/concept.md')).toBeNull();
    expect(buildWriteGuard('test/scenario.test.ts')).toBeNull();
    expect(buildWriteGuard('package.json')).toBeNull();
  });

  it('does not refuse a file that merely starts like the model', () => {
    // `spec/models/` and `spec/model-notes.md` are not the model.
    expect(buildWriteGuard('spec/models/extra.ts')).toBeNull();
    expect(buildWriteGuard('spec/model-notes.md')).toBeNull();
  });
});

describe('build context (#681)', () => {
  const ws = (files: Record<string, string>) => ({
    exists: async (p: string) => p in files,
    readFile: async (p: string) => files[p] ?? '',
  });

  it('interview turns get no concept', async () => {
    expect(await buildContext(ws({}), 'interview')).toContain('no concept document yet');
  });

  it('model turns get the concept but NOT the model', async () => {
    // The model phase is writing that file; handing it back would invite an
    // edit-in-place loop rather than a considered declaration.
    const out = await buildContext(ws({ 'spec/concept.md': 'C', 'spec/model.ts': 'M' }), 'model');
    expect(out).toBe('C');
  });

  it('build turns get the concept AND the model, marked approved', async () => {
    const out = await buildContext(ws({ 'spec/concept.md': 'C', 'spec/model.ts': 'M' }), 'scaffold');
    expect(out).toContain('C');
    expect(out).toContain('M');
    expect(out).toMatch(/transcribe, do not re-derive/i);
  });

  it('tolerates a project that predates the model phase', async () => {
    // Existing projects have a concept and no model; they must keep building.
    const out = await buildContext(ws({ 'spec/concept.md': 'C' }), 'iterate');
    expect(out).toBe('C');
  });
});
