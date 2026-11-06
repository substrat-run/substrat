import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '../src');
const theme = readFileSync(join(src, 'elements-theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ownTokens = readdirSync(join(src, 'tokens'))
  .map((f) => readFileSync(join(src, 'tokens', f), 'utf8'))
  .join('\n');

// A misspelt custom property is not an error anywhere: it just leaves the default standing.
describe('elements-theme.css', () => {
  it('reads only tokens this package defines', () => {
    const read = [...theme.matchAll(/var\((--(?!wa-)[\w-]+)\)/g)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((t) => !ownTokens.includes(`${t}:`))).toEqual([]);
  });

  it("sets only tokens Web Awesome's theme declares", () => {
    const require = createRequire(join(src, '../../elements/package.json'));
    const dist = dirname(require.resolve('@awesome.me/webawesome/dist/styles/themes/default.css'));
    const declared = ['default.css', '../color/variants/brand.css', '../color/variants/neutral.css']
      .map((f) => readFileSync(join(dist, f), 'utf8'))
      .join('\n');
    const set = [...theme.matchAll(/^\s*(--wa-[\w-]+):/gm)].map((m) => m[1]!);
    expect(set.length).toBeGreaterThan(0);
    expect(set.filter((t) => !declared.includes(`${t}:`))).toEqual([]);
  });
});
