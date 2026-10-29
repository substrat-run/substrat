/** Trusted file materializer, invoked before any submitted code is executed. */
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sourceSnapshot } from '@substrat-run/contracts';

const root = process.argv[2]!;
const snapshot = sourceSnapshot.parse(JSON.parse(readFileSync(process.argv[3]!, 'utf8')));
// Replacing a tree includes deletions; keep only the repository's own control directory.
for (const entry of readdirSync(root)) {
  if (entry !== '.git') rmSync(join(root, entry), { recursive: true, force: true });
}
for (const file of snapshot.files) {
  const path = join(root, file.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(file.base64, 'base64'));
  chmodSync(path, file.executable ? 0o755 : 0o644);
}
