import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Classification } from '../src/bump.js';
import {
  CannotRun,
  changesetDirFor,
  checkPackages,
  computeFor,
  defaultBase,
  parseChangeset,
  renderChangeset,
  report,
  verdictFor,
  writeChangeset,
} from '../src/changeset.js';

/**
 * `substrat changeset` and its `--check` (#2364): the computed bump against what a changeset
 * declares. The override is a reviewed escape hatch, so its grammar is held strictly — a
 * malformed one fails, one without a reason fails, and one never reaches a package its own
 * changeset does not release.
 */

const PKG = '@acme/vertical';
const OTHER = '@acme/other';
const result = (bump: Classification['bump']): Classification => ({
  bump,
  changes: bump === 'none' ? [] : [{ level: bump, artifact: 'model', path: 'entities.list', detail: 'entity removed' }],
});
const cs = (file: string, front: string, body = 'A change.') => parseChangeset(file, `---\n${front}\n---\n\n${body}\n`);
const NO_FIXED = new Set<string>();

describe('parseChangeset', () => {
  it('reads every release line, quoted or not', () => {
    const c = cs('a.md', `'${PKG}': minor\n"${OTHER}": patch\nplain: major`);
    expect([...c.releases]).toEqual([[PKG, 'minor'], [OTHER, 'patch'], ['plain', 'major']]);
    expect(c.problems).toEqual([]);
  });

  it('a well-formed override is read; its twin without a reason is refused', () => {
    const ok = cs('a.md', `'${PKG}': minor`, `Body.\n\n<!-- bump-override: ${PKG} minor — the removed entity was never released -->`);
    expect(ok.overrides).toEqual([{ pkg: PKG, level: 'minor', reason: 'the removed entity was never released' }]);
    expect(ok.problems).toEqual([]);
    const bare = cs('a.md', `'${PKG}': minor`, `<!-- bump-override: ${PKG} minor — -->`);
    expect(bare.overrides).toEqual([]);
    expect(bare.problems).toEqual([expect.stringMatching(/gives no reason/)]);
  });

  it('an override without a level, or without its dash, is malformed', () => {
    for (const line of [
      `<!-- bump-override: ${PKG} — reason -->`,
      `<!-- bump-override: ${PKG} minor reason -->`,
      `<!-- bump-override: minor — reason -->`,
      `bump-override: ${PKG} minor — reason`,
    ]) {
      const c = cs('a.md', `'${PKG}': minor`, line);
      expect(c.overrides, line).toEqual([]);
      expect(c.problems, line).toEqual([expect.stringMatching(/malformed override/)]);
    }
  });

  it('an override for a package its changeset does not release is refused', () => {
    const c = cs('a.md', `'${PKG}': minor`, `<!-- bump-override: ${OTHER} minor — reason -->`);
    expect(c.overrides).toEqual([]);
    expect(c.problems).toEqual([expect.stringMatching(/does not release/)]);
  });

  it('an override whose level differs from what its changeset declares is refused', () => {
    const c = cs('a.md', `'${PKG}': minor`, `<!-- bump-override: ${PKG} patch — reason -->`);
    expect(c.problems).toEqual([expect.stringMatching(/says patch, but this changeset declares minor/)]);
  });

  it('a file without frontmatter is a problem, not an empty changeset', () => {
    expect(parseChangeset('a.md', 'just text').problems).toEqual([expect.stringMatching(/no frontmatter/)]);
    expect(parseChangeset('a.md', '---\nfoo: minor\n').problems).toEqual([expect.stringMatching(/no frontmatter/)]);
  });

  it('an EMPTY changeset (what `changeset --empty` writes) releases nothing and is not a problem', () => {
    // Verbatim copy of an empty changeset this repo has merged.
    const empty =
      "---\n---\n\nKeep the private root's TypeScript and Wrangler ranges aligned with the catalog so Dependabot " +
      'updates produce a frozen-installable lockfile (#1621).\n';
    const c = parseChangeset('dependabot-root-catalog.md', empty);
    expect(c.problems).toEqual([]);
    expect(c.releases.size).toBe(0);
    expect(parseChangeset('e.md', '---\r\n---\r\n').problems).toEqual([]);
  });
});

describe('verdictFor', () => {
  it('declared at or above the computed bump is ok', () => {
    expect(verdictFor(PKG, result('minor'), [cs('a.md', `'${PKG}': minor`)], NO_FIXED).status).toBe('ok');
    expect(verdictFor(PKG, result('minor'), [cs('a.md', `'${PKG}': major`)], NO_FIXED).status).toBe('ok');
  });

  it('declared below the computed bump is under-declared — the failure', () => {
    const v = verdictFor(PKG, result('major'), [cs('a.md', `'${PKG}': patch`)], NO_FIXED);
    expect(v.status).toBe('under-declared');
    expect(report(v).failed).toBe(true);
  });

  it('the highest declaration across every changeset is what releases, so it is what counts', () => {
    const v = verdictFor(PKG, result('major'), [cs('a.md', `'${PKG}': patch`), cs('b.md', `'${PKG}': major`)], NO_FIXED);
    expect(v).toMatchObject({ status: 'ok', declared: 'major' });
  });

  it('an override on the changeset that releases the package lets it through, and is printed', () => {
    const v = verdictFor(
      PKG,
      result('major'),
      [cs('a.md', `'${PKG}': minor`, `<!-- bump-override: ${PKG} minor — the entity was added this release -->`)],
      NO_FIXED,
    );
    expect(v.status).toBe('overridden');
    const r = report(v);
    expect(r.failed).toBe(false);
    expect(r.lines.join('\n')).toMatch(/OVERRIDDEN[\s\S]*the entity was added this release/);
  });

  it("an override never applies to a package its changeset does not name", () => {
    // `a.md` releases OTHER and overrides it; PKG's own changeset carries no override.
    const v = verdictFor(
      PKG,
      result('major'),
      [cs('a.md', `'${OTHER}': minor`, `<!-- bump-override: ${OTHER} minor — reason -->`), cs('b.md', `'${PKG}': minor`)],
      NO_FIXED,
    );
    expect(v.status).toBe('under-declared');
  });

  it('no changeset naming the package is a warning carrying the computed bump, not a failure', () => {
    const v = verdictFor(PKG, result('minor'), [cs('a.md', `'${OTHER}': patch`)], NO_FIXED);
    expect(v.status).toBe('missing');
    const r = report(v);
    expect(r.failed).toBe(false);
    expect(r.lines[0]).toMatch(new RegExp(`${PKG}.*computed bump minor`));
  });

  it('nothing changed and nothing declared is ok', () => {
    expect(verdictFor(PKG, result('none'), [], NO_FIXED).status).toBe('ok');
  });

  it('a package in a fixed group is skipped: its changeset stays hand-written', () => {
    const v = verdictFor(PKG, result('major'), [cs('a.md', `'${PKG}': patch`)], new Set([PKG]));
    expect(v.status).toBe('skipped-fixed');
    expect(report(v).failed).toBe(false);
  });

  it('a flagged permission change is reported for the human checkpoint, whatever the verdict', () => {
    const flagged: Classification = {
      bump: 'minor',
      changes: [{ level: 'minor', artifact: 'permissions', path: 'role member', detail: 'no longer holds list:read — narrowing', flagged: true }],
    };
    const r = report(verdictFor(PKG, flagged, [cs('a.md', `'${PKG}': minor`)], NO_FIXED));
    expect(r.failed).toBe(false);
    expect(r.lines.join('\n')).toMatch(/human checkpoint — role member: no longer holds list:read/);
  });
});

describe('renderChangeset', () => {
  it('writes a changeset that parses back to the computed bump', () => {
    const text = renderChangeset(PKG, result('major'));
    const back = parseChangeset('x.md', text);
    expect([...back.releases]).toEqual([[PKG, 'major']]);
    expect(back.problems).toEqual([]);
    expect(text).toMatch(/entities\.list.*entity removed/);
  });

  it('refuses to write a bump of none', () => {
    expect(() => renderChangeset(PKG, result('none'))).toThrow(/nothing changed/);
  });
});

/** A throwaway repo holding one vertical, a changesets config and a base commit on `main`. */
describe('against a git checkout', () => {
  let repo: string;
  let pkgDir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const MODEL = {
    entities: {
      list: { table: 'lists', fields: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id'] } },
    },
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'substrat-changeset-'));
    pkgDir = join(repo, 'verticals', 'acme');
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(join(repo, '.changeset'));
    writeFileSync(join(repo, '.changeset', 'config.json'), JSON.stringify({ baseBranch: 'main', fixed: [] }));
    writeFileSync(join(repo, '.changeset', 'README.md'), '# Changesets\n');
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version: '0.1.0' }));
    writeFileSync(join(pkgDir, 'model.json'), JSON.stringify(MODEL, null, 2));
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const removeName = () => {
    const m = structuredClone(MODEL) as any;
    delete m.entities.list.fields.properties.name;
    writeFileSync(join(pkgDir, 'model.json'), JSON.stringify(m, null, 2));
  };

  it('computes the bump from the working tree against the merge-base', () => {
    expect(computeFor(pkgDir, 'main').result.bump).toBe('none');
    removeName();
    const { pkg, result: r } = computeFor(pkgDir, 'main');
    expect(pkg).toBe(PKG);
    expect(r.bump).toBe('major');
  });

  it('the default base is the changesets baseBranch, as a local branch when there is no remote', () => {
    expect(defaultBase(changesetDirFor(pkgDir, repo), repo)).toBe('main');
  });

  it('a base the checkout does not hold is a refusal, never "everything is new"', () => {
    removeName();
    expect(() => computeFor(pkgDir, 'origin/nowhere')).toThrow(CannotRun);
  });

  it('a written changeset passes the check; a hand-written lower one fails it', () => {
    removeName();
    const { pkg, result: r } = computeFor(pkgDir, 'main');
    const dir = changesetDirFor(pkgDir, repo);
    const file = writeChangeset(dir, pkg, r);
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`'${PKG}': major`));
    expect(checkPackages([{ pkg, result: r }], dir).failed).toBe(false);

    rmSync(file);
    writeFileSync(join(dir, 'hand.md'), `---\n'${PKG}': patch\n---\n\nTidy up.\n`);
    const checked = checkPackages([{ pkg, result: r }], dir);
    expect(checked.failed).toBe(true);
    expect(checked.lines.join('\n')).toMatch(/declares patch, but the change is major/);
  });

  it('a malformed override anywhere fails the check, even on a package that is fine', () => {
    const dir = changesetDirFor(pkgDir, repo);
    writeFileSync(join(dir, 'odd.md'), `---\n'${OTHER}': patch\n---\n\n<!-- bump-override: ${OTHER} patch -->\n`);
    const checked = checkPackages([{ pkg: PKG, result: result('none') }], dir);
    expect(checked.failed).toBe(true);
    expect(checked.lines[0]).toMatch(/malformed override/);
  });

  it('a project with no .changeset/config.json is refused, not written into', () => {
    rmSync(join(repo, '.changeset'), { recursive: true });
    expect(() => changesetDirFor(pkgDir, repo)).toThrow(/does not release with changesets/);
  });
});
