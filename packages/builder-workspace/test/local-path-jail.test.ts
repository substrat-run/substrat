import { existsSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalWorkspace } from '../src/index.js';

/**
 * `LocalWorkspace`'s path boundary (#1225).
 *
 * The guard's own comment used to claim it stopped "a symlink whose target escapes,
 * which is why this resolves rather than string-matching". `resolve()` is purely
 * lexical: it normalises `..` and never touches the filesystem, so a link inside the
 * root pointing anywhere on the machine resolved to a path INSIDE the root and went
 * straight through.
 *
 * For mode A that is defence in depth rather than a breach — `exec` runs `shell: true`
 * on the host, so an agent that can run a command can already read anything this would
 * have stopped. It matters because a guard that advertises a protection invites the next
 * caller to lean on it.
 */
describe('LocalWorkspace path jail (#1225)', () => {
  let dir: string;
  let ws: LocalWorkspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-jail-'));
    mkdirSync(join(dir, 'root'));
    writeFileSync(join(dir, 'outside.txt'), 'SECRET-OUTSIDE');
    writeFileSync(join(dir, 'root', 'inside.txt'), 'ordinary');
    ws = new LocalWorkspace({ root: join(dir, 'root'), id: 'jail-test' });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads an ordinary file, so the guard is not simply refusing everything', async () => {
    // The failure this test exists to rule out: a containment check that compares a
    // REAL path against a LEXICAL root rejects every path on a machine whose temp dir
    // is itself a symlink — `/var/folders/…` is `/private/var/folders/…` on macOS —
    // and a suite that only asserted refusals would call that a pass.
    await expect(ws.readFile('inside.txt')).resolves.toBe('ordinary');
  });

  it('refuses an absolute path', async () => {
    await expect(ws.readFile(join(dir, 'outside.txt'))).rejects.toThrow(/absolute/);
  });

  it('refuses a climb out with ..', async () => {
    await expect(ws.readFile('../outside.txt')).rejects.toThrow(/escapes the workspace root/);
  });

  it('refuses a read THROUGH a symlink that leaves the root', async () => {
    // The gap. Lexically `escape.txt` is inside the root, so the old guard allowed it
    // and `readFile` followed the link. Probed by hand before the fix: it returned the
    // outside file's contents.
    symlinkSync(join(dir, 'outside.txt'), join(dir, 'root', 'escape.txt'));
    await expect(ws.readFile('escape.txt')).rejects.toThrow(/escapes the workspace root/);
  });

  it('refuses a read through a symlinked DIRECTORY', async () => {
    // The same escape one level up, which a check that only looked at the final
    // component would miss.
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'secret.txt'), 'SECRET-OUTSIDE');
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'root', 'link'));
    await expect(ws.readFile('link/secret.txt')).rejects.toThrow(/escapes the workspace root/);
  });

  it('refuses a WRITE through a symlink that leaves the root', async () => {
    // Writing through the link is the worse half: it clobbers a file outside the
    // workspace rather than merely reading one.
    symlinkSync(join(dir, 'outside.txt'), join(dir, 'root', 'escape.txt'));
    await expect(ws.writeFile('escape.txt', 'clobbered')).rejects.toThrow(/escapes the workspace root/);
  });

  it('refuses a WRITE through a DANGLING symlink that leaves the root', async () => {
    // The bypass a "nearest existing ancestor" walk hands over on its own: the link
    // exists but its target does not, so `realpath` reports ENOENT exactly as it does
    // for a missing segment, the walk resolves the parent instead, and the link's
    // lexical in-root path passes. `writeFile` then follows the link and CREATES the
    // target outside the root — a write to a file that did not exist, outside the
    // jail, from a path the jail approved.
    symlinkSync(join(dir, 'outside-new.txt'), join(dir, 'root', 'escape.txt'));
    await expect(ws.writeFile('escape.txt', 'planted')).rejects.toThrow(/escapes the workspace root/);
    expect(existsSync(join(dir, 'outside-new.txt'))).toBe(false);
  });

  it('refuses a write under a DANGLING symlinked directory', async () => {
    // Same bypass one level up: the link's target directory does not exist, so nothing
    // under it has a realpath, and only following the link by hand shows where the
    // write would have landed.
    symlinkSync(join(dir, 'elsewhere-new'), join(dir, 'root', 'link'));
    await expect(ws.writeFile('link/planted.txt', 'planted')).rejects.toThrow(/escapes the workspace root/);
    expect(existsSync(join(dir, 'elsewhere-new'))).toBe(false);
  });

  it('allows a dangling symlink that stays INSIDE the root', async () => {
    // The dangling half of containment-not-a-ban: a link to a not-yet-written file in
    // the root is a legitimate first write, and refusing every dangling link would be
    // a different bug with the same test count.
    symlinkSync(join(dir, 'root', 'target-new.txt'), join(dir, 'root', 'alias.txt'));
    await ws.writeFile('alias.txt', 'through the link');
    await expect(ws.readFile('target-new.txt')).resolves.toBe('through the link');
  });

  it('still writes a file that does not exist yet', async () => {
    // A new path has no realpath at all, so the guard resolves its nearest existing
    // ancestor instead. Get that wrong and every first write to a new file fails —
    // which is most of what the builder does.
    await ws.writeFile('nested/deep/new.txt', 'created');
    await expect(ws.readFile('nested/deep/new.txt')).resolves.toBe('created');
  });

  it('allows a symlink that stays INSIDE the root', async () => {
    // Containment, not a ban on links: a link is only a problem when it leaves.
    symlinkSync(join(dir, 'root', 'inside.txt'), join(dir, 'root', 'alias.txt'));
    await expect(ws.readFile('alias.txt')).resolves.toBe('ordinary');
  });
});
