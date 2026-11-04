// Packs a driver release directory into src/graph-release.bin, the one Data module the supervisor
// reads it from. With no --release, writes an empty pack, so the script still builds.
//
//   node build-graph.mjs --release <dir> --entry <python.module> --class <ClassName>
//
// <dir> is the release as it is uploaded: one driver_<package>/ and, optionally, python_modules/.
// <python.module> is the module that defines the class, e.g. driver_graph.store.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { release: { type: 'string' }, entry: { type: 'string' }, class: { type: 'string' } } });
const out = new URL('./src/graph-release.bin', import.meta.url);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = [];
const chunks = [];
let offset = 0;
if (values.release) {
  if (!values.entry || !values.class) throw new Error('--entry and --class are required with --release');
  for (const path of walk(values.release).sort()) {
    const name = relative(values.release, path).split(sep).join('/');
    if (name.startsWith('.') || name.includes('/__pycache__/') || name.endsWith('.pyc')) continue;
    const bytes = readFileSync(path);
    files.push({ name, offset, length: bytes.length });
    chunks.push(bytes);
    offset += bytes.length;
  }
}
const index = Buffer.from(JSON.stringify({ entry: values.entry ?? null, className: values.class ?? null, files }));
const header = Buffer.alloc(4);
header.writeUInt32LE(index.length, 0);
const pack = Buffer.concat([header, index, ...chunks]);
writeFileSync(out, pack);
console.log(`graph-release.bin: ${files.length} files, ${offset} bytes of release, ${pack.length} bytes packed`);
