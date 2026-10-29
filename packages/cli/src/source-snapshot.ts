import { execFileSync, execSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { excludedSourcePath, sourceSnapshot, SOURCE_BYTES_MAX, type SourceSnapshot } from '@substrat-run/contracts';

/** Include workspace manifests and local packages when pushing a monorepo member. */
export function collectSourceSnapshot(directory: string): SourceSnapshot {
  const dir = realpathSync(resolve(directory));
  let root = dir;
  let parent = dir;
  while (true) {
    if (existsSync(join(parent, 'pnpm-workspace.yaml'))) {
      if (!excludedSourcePath(relative(parent, dir).split(sep).join('/'))) root = parent;
      break;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  let included: string[] | undefined;
  if (root !== dir) {
    // Resolve the workspace graph without installing or building anything. Include
    // nested browser packages as well as the vertical's declared dependencies.
    // A constant shell command also resolves pnpm.cmd on Windows; no project input is interpolated.
    const members = JSON.parse(execSync('pnpm -r list --depth -1 --json',
      { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })) as Array<{ name?: string; path: string }>;
    // pnpm may report forward slashes on Windows; compare canonical native paths.
    for (const member of members) member.path = resolve(member.path);
    const byName = new Map(members.filter((m) => m.name).map((m) => [m.name!, m]));
    const selected = new Set(members.filter((m) => m.path === dir || m.path.startsWith(`${dir}${sep}`)).map((m) => m.path));
    selected.add(dir);
    const queue = [...selected];
    for (const path of queue) {
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
      for (const name of Object.keys(deps)) {
        const member = byName.get(name);
        if (member && !selected.has(member.path)) { selected.add(member.path); queue.push(member.path); }
      }
    }
    included = [...selected].map((p) => `${relative(root, p).split(sep).join('/')}/`);
  }
  let names: string[];
  const gitExecutable = new Set<string>();
  try {
    names = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
    if (process.platform === 'win32') {
      const modes = execFileSync('git', ['-C', root, 'ls-files', '--stage', '-z', '--', '.'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const entry of modes.split('\0')) {
        const match = /^100755 [0-9a-f]+ \d\t(.+)$/.exec(entry);
        if (match) gitExecutable.add(match[1]!);
      }
    }
    // git prints paths relative to cwd; it must never select an ancestor's unrelated files.
  } catch {
    const walk = (prefix: string): string[] => readdirSync(join(root, prefix)).flatMap((name) => {
      const path = prefix ? `${prefix}/${name}` : name;
      if (excludedSourcePath(path)) return [];
      const stat = lstatSync(join(root, path));
      return stat.isDirectory() ? walk(path) : [path];
    });
    names = walk('');
  }
  const files: SourceSnapshot['files'] = [];
  let bytes = 0;
  for (const path of [...new Set(names)].sort()) {
    if (excludedSourcePath(path)) continue;
    if (included && path.includes('/') && !path.startsWith('tools/') && !path.startsWith('scripts/') && !included.some((prefix) => path.startsWith(prefix))) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue; // tracked deletion
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`source snapshot refuses symlink: ${path}`);
    if (!stat.isFile()) continue;
    const real = realpathSync(absolute);
    if (!real.startsWith(`${root}${sep}`)) throw new Error(`source path escapes the project: ${path}`);
    bytes += Math.ceil(stat.size / 3) * 4;
    if (bytes > SOURCE_BYTES_MAX) throw new Error('source snapshot exceeds the upload limit');
    files.push({ path, base64: readFileSync(real).toString('base64'), executable: process.platform === 'win32' ? gitExecutable.has(path) : Boolean(stat.mode & 0o111) });
  }
  return sourceSnapshot.parse({ files, directory: relative(root, dir).split(sep).join('/') || '.' });
}
