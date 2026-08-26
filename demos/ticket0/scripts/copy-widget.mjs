/**
 * Put `widget/widget.js` beside the built SPA, so the deployed desk serves it as a
 * static asset from the edge.
 *
 * The dev server hands it out from `src/server.ts` with a cache header; a hosted desk
 * has no reason to invoke a worker for a file that never changes between deploys. It
 * is NOT part of the SPA's import graph — it is somebody else's page's script — so
 * Vite would never see it, which is why this is a copy rather than an import.
 *
 * `widget.js` derives its API base from its own `src` origin, so a page embedding
 * `<script src="https://desk.example/widget.js">` talks to that desk with no
 * `data-api` and nothing baked in at build time.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'app', 'dist');
mkdirSync(dest, { recursive: true });
copyFileSync(join(root, 'widget', 'widget.js'), join(dest, 'widget.js'));
process.stdout.write('copied widget/widget.js → app/dist/widget.js\n');
