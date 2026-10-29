import { describe, expect, it } from 'vitest';
import { sourceBuildRequest, sourceSnapshot } from '../src/source-build.js';

const file = (path: string) => ({ path, base64: 'e30=' });
describe('source trust boundary', () => {
  it.each(['../escape', '/absolute', 'a/../../escape', '.git/config', 'a/.GIT/config', 'a\\escape', '.env.production', '.dev.vars', '.npmrc', 'secrets/token'])('refuses %s', (path) => {
    expect(sourceSnapshot.safeParse({ files: [file('package.json'), file(path)] }).success).toBe(false);
  });
  it('refuses duplicates and a file occupying a directory path', () => {
    for (const files of [[file('package.json'), file('PACKAGE.json')], [file('package.json'), file('src'), file('src/app.ts')]]) {
      expect(sourceSnapshot.safeParse({ files }).success).toBe(false);
    }
  });
  it('requires the selected build directory and exactly one immutable source input', () => {
    const snapshot = { files: [file('package.json')] };
    expect(sourceSnapshot.safeParse({ ...snapshot, directory: 'missing' }).success).toBe(false);
    expect(sourceBuildRequest.safeParse({ version: '1.0.0' }).success).toBe(false);
    expect(sourceBuildRequest.safeParse({ version: '1.0.0', snapshot, revision: 'a'.repeat(40) }).success).toBe(false);
    expect(sourceBuildRequest.safeParse({ version: '1.0.0', revision: 'main' }).success).toBe(false);
    expect(sourceBuildRequest.safeParse({ version: '1.0.0', snapshot, manifest: {} }).success).toBe(false);
    expect(sourceBuildRequest.safeParse({ version: '1.0.0', snapshot }).success).toBe(true);
  });
});
