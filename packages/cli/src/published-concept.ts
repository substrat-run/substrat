import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CONCEPT_BYTES_MAX, publishedConcept } from '@substrat-run/contracts';

/** Publish only an explicitly named file. A design document's mere existence grants no access. */
export function readPublishedConcept(dir: string): string | undefined {
  const packageFile = resolve(dir, 'package.json');
  if (!existsSync(packageFile)) return undefined;
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as { substrat?: { concept?: unknown } };
  const path = pkg.substrat?.concept;
  if (path === undefined) return undefined;
  if (typeof path !== 'string' || !path.trim() || isAbsolute(path)) {
    throw new Error('substrat.concept must name a file relative to the application directory');
  }
  const root = realpathSync(dir);
  const file = realpathSync(resolve(root, path));
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('substrat.concept must stay inside the application directory, including symlinks');
  }
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > CONCEPT_BYTES_MAX) {
    throw new Error(`substrat.concept must be a file of at most ${CONCEPT_BYTES_MAX} UTF-8 bytes`);
  }
  return publishedConcept.parse(readFileSync(file, 'utf8'));
}
