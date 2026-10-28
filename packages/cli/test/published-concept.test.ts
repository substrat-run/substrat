import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONCEPT_BYTES_MAX, publishedConcept } from '@substrat-run/contracts';
import { readPublishedConcept } from '../src/published-concept.js';
import { built, pushed, vertical } from './push-harness.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-published-concept-'));
  mkdirSync(join(dir, 'spec'));
  writeFileSync(join(dir, 'spec/concept.md'), '# Desk\n\nManagers approve orders.\n');
  writeFileSync(join(dir, 'package.json'), '{}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const configure = (concept: unknown) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ substrat: { concept } }));

it('keeps a concept private unless the owner explicitly publishes a file', () => {
  expect(readPublishedConcept(dir)).toBeUndefined();
  rmSync(join(dir, 'package.json'));
  expect(readPublishedConcept(dir)).toBeUndefined();
  configure('spec/concept.md');
  expect(readPublishedConcept(dir)).toBe('# Desk\n\nManagers approve orders.');
});

it.each([true, '', '/etc/hosts'])('refuses invalid publication setting %j', (value) => {
  configure(value);
  expect(() => readPublishedConcept(dir)).toThrow(/substrat.concept/);
});

it('refuses missing files and symlinks outside the application', () => {
  configure('missing.md');
  expect(() => readPublishedConcept(dir)).toThrow();
  symlinkSync(join(dir, '..'), join(dir, 'outside'));
  configure('outside');
  expect(() => readPublishedConcept(dir)).toThrow(/inside the application/);
});

it('bounds the published document in bytes at both the CLI and wire boundary', () => {
  configure('spec/concept.md');
  const text = '🙂'.repeat(CONCEPT_BYTES_MAX / 4 + 1);
  writeFileSync(join(dir, 'spec/concept.md'), text);
  expect(() => readPublishedConcept(dir)).toThrow(/UTF-8 bytes/);
  expect(publishedConcept.safeParse(text).success).toBe(false);
  expect(publishedConcept.safeParse(' ').success).toBe(false);
});

describe.runIf(built)('published concept in the release upload', () => {
  // Boots the built CLI, permission loader and fake wrangler in a subprocess; unlike the
  // pure checks above this exercises the upload boundary and takes several seconds.
  it('carries exactly the opted-in snapshot in the real push manifest', () => {
    const app = vertical([{ id: 'helpdesk' }]);
    try {
      const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
      pkg.substrat.concept = 'about.md';
      writeFileSync(join(app, 'package.json'), JSON.stringify(pkg));
      writeFileSync(join(app, 'about.md'), '# Helpdesk\n\nShared inbox.\n');
      expect(pushed(app).concept).toBe('# Helpdesk\n\nShared inbox.');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 30_000);
});
