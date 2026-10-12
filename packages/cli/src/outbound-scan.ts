/**
 * `push --check` / `push`: warn when the vertical's code names a host `substrat.outbound`
 * does not declare (#2193).
 *
 * `vertical-egress` refuses a subrequest to an undeclared host (`403 outbound refused`),
 * and boundary-lint judges `fetch` in module code only — so a host called from harness code
 * (an integration module the worker entry imports) used to surface first as a production
 * refusal that reads like an upstream 403. This reads the entry's SOURCE import graph, the
 * way `sweeperClassesOf` does, and compares each `http(s)://host` literal with the declared
 * list through `matchesOutboundHost` — the function the egress worker enforces with.
 *
 * Best effort by design. It finds a host written out as a literal (a string, or a template
 * with no `${}` part), including inside `new URL('https://…')`. A host built at runtime, read
 * from an env var or config, or reached through a dependency is invisible, and the report says
 * so: a clean run is not a guarantee. Comments are never read (the AST has no string in them),
 * and names that can never be declared or are not a third party (`localhost`, IPs, `*.internal`,
 * `example.com`, the `w3.org` XML namespaces) are skipped rather than reported.
 *
 * A declared host never found is a NOTE, not a failure: declarations are reviewed at the admit
 * checkpoint, so nothing here shrinks one silently.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import { matchesOutboundHost, outboundHost } from '@substrat-run/contracts';
import { resolveRelative, SOURCE_EXTENSIONS } from './schedule-sweeper.js';

export interface OutboundSighting {
  host: string;
  /** Path relative to the vertical root. */
  file: string;
  line: number;
}

const URL_LITERAL = /https?:\/\/[^\s'"`<>)\\]+/gi;
/** Names that can never be declared (or are not a third party): not worth a warning. */
const IGNORED = /(^|\.)(localhost|internal|local|test|example|invalid)$|(^|\.)(example\.(com|org|net)|w3\.org)$/;

/** The declarable hostname of a URL literal, or undefined when it is not a third-party host. */
function hostOf(text: string): string | undefined {
  let host: string;
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (IGNORED.test(host) || !outboundHost.safeParse(host).success) return undefined;
  return host;
}

function* nodesOf(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const n of node) yield* nodesOf(n);
  } else if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    if (typeof n.type === 'string') yield n;
    for (const [key, value] of Object.entries(n)) {
      if (key !== 'loc' && key !== 'leadingComments' && key !== 'trailingComments') yield* nodesOf(value);
    }
  }
}

function parseSource(source: string, file: string) {
  return parse(source, {
    sourceType: 'module',
    plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    errorRecovery: true,
  });
}

/** What one source file contributes: the host literals it names and the relative modules it loads. */
export function readSource(source: string, file = 'file.ts'): { hosts: { host: string; line: number }[]; imports: string[] } {
  const ast = parseSource(source, file);
  const hosts: { host: string; line: number }[] = [];
  const imports: string[] = [];
  /** Literals a `+` continues: `'https://api.acme' + '.com'` ends mid-host, and the host is not `api.acme`. */
  const continued = new Set<unknown>();
  for (const node of nodesOf(ast.program)) {
    let text: string | undefined;
    let open = false;
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      let left = node.left as Record<string, unknown>;
      while (left.type === 'BinaryExpression' && left.operator === '+') left = left.right as Record<string, unknown>;
      continued.add(left);
    }
    if (node.type === 'StringLiteral') {
      text = node.value as string;
      open = continued.has(node);
    } else if (node.type === 'TemplateElement') {
      text = (node.value as { cooked?: string | null }).cooked ?? undefined;
      open = node.tail === false;
    }
    else if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const spec = (node.source as { value?: string } | null)?.value;
      if (spec?.startsWith('.')) imports.push(spec);
    } else if (node.type === 'CallExpression' && (node.callee as { type: string }).type === 'Import') {
      // `await import('./x.js')`: a lazily loaded integration still ships.
      const arg = (node.arguments as { type: string; value?: string }[])[0];
      if (arg?.type === 'StringLiteral' && arg.value?.startsWith('.')) imports.push(arg.value);
    }
    if (!text) continue;
    const line = (node.loc as { start: { line: number } }).start.line;
    for (const match of text.matchAll(URL_LITERAL)) {
      // Running to the end of a literal that something continues, with no delimiter, is a host cut short.
      if (open && match.index + match[0].length === text.length && !/[/?#:]$/.test(match[0])) continue;
      const host = hostOf(match[0]);
      if (host) hosts.push({ host, line });
    }
  }
  return { hosts, imports };
}

export interface OutboundScan {
  sightings: OutboundSighting[];
  /** Files that could not be read or parsed: their hosts were NOT checked. */
  unread: string[];
}

/**
 * Every host literal in the entry's relative import graph. Only source files are followed — a
 * `.sql`, `.json` or `.md` import (a Workers text rule) is not JavaScript — and a file that
 * cannot be read or parsed is reported in `unread` rather than ending the walk, so what the
 * rest of the graph named still counts and a skipped file is never a silent pass.
 */
export function scanOutboundHosts(dir: string, entry: string): OutboundScan {
  const seen = new Set<string>();
  const sightings: OutboundSighting[] = [];
  const unread: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let read: ReturnType<typeof readSource>;
    try {
      read = readSource(readFileSync(file, 'utf8'), file);
    } catch {
      unread.push(relative(dir, file));
      return;
    }
    for (const hit of read.hosts) sightings.push({ ...hit, file: relative(dir, file) });
    for (const spec of read.imports) {
      const target = resolveRelative(file, spec);
      if (target && SOURCE_EXTENSIONS.some((ext) => target.endsWith(ext))) visit(target);
    }
  };
  visit(resolve(dir, entry));
  return { sightings, unread };
}

export interface OutboundReport {
  /** Hosts the code names that the declaration does not cover, first sighting each. */
  undeclared: OutboundSighting[];
  /** Declared entries no literal in the code matches. */
  stale: string[];
}

export function judgeOutbound(sightings: readonly OutboundSighting[], declared: readonly string[]): OutboundReport {
  const undeclared: OutboundSighting[] = [];
  for (const s of sightings) {
    if (!matchesOutboundHost(s.host, declared) && !undeclared.some((u) => u.host === s.host)) undeclared.push(s);
  }
  const stale = declared.filter((d) => !sightings.some((s) => matchesOutboundHost(s.host, [d])));
  return { undeclared, stale };
}

/**
 * Scan, report through `log`, and throw only under `strict`. A file that cannot be read is a
 * note, never a failure and never silence.
 */
export function checkOutboundDeclared(
  dir: string,
  entry: string | undefined,
  declared: readonly unknown[] | undefined,
  opts: { strict?: boolean; log?: (message: string) => void } = {},
): void {
  const log = opts.log ?? console.log;
  if (!entry) return;
  const { sightings, unread } = scanOutboundHosts(dir, entry);
  for (const file of unread) log(`note: could not read ${file}, its hosts were not checked.`);
  const hosts = (declared ?? []).filter((h): h is string => typeof h === 'string');
  const { undeclared, stale } = judgeOutbound(sightings, hosts);
  if (undeclared.length > 0) {
    const lines = undeclared.map((u) => `  ${u.host}  (${u.file}:${u.line})`);
    const add = JSON.stringify([...hosts, ...undeclared.map((u) => u.host)]);
    const plural = undeclared.length > 1;
    const message =
      `${opts.strict ? 'error' : 'warning'}: the code names ${plural ? 'hosts' : 'a host'} ` +
      `package.json substrat.outbound does not declare — the egress worker refuses ` +
      `${plural ? 'them' : 'it'} (403 outbound refused) at run time:\n${lines.join('\n')}\n` +
      `  add to package.json: "outbound": ${add}\n` +
      `  (best effort: hosts built at runtime or read from config are not found, so a clean run is not a guarantee)`;
    if (opts.strict) throw new Error(message);
    log(message);
  }
  if (stale.length > 0) {
    log(
      `note: substrat.outbound declares ${stale.join(', ')}, which no literal in the code names ` +
        `(a host built at runtime would not be found); declarations are kept as written.`,
    );
  }
}
