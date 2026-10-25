/**
 * Every path where a host seats or defines a role asks the reserved-key rule first (#2447).
 *
 * A key a module declares `holder: 'system'` is no person's (#2430, K-55). The rule is the
 * kernel's (`reservedRoleRefusal` for a seat, `reservedRoleDefinitionRefusal` and
 * `reservedRoleSetRefusal` for a definition), and each door asks it before it writes. A new
 * door that skipped it would seat a person in a role carrying such a key, or let a role be
 * widened after it was assigned, and every suite would stay green, because none of them drives
 * the new door. #2447 found three such paths that way: a role definition, the provisioning
 * owner seat and the owner hand-over.
 *
 * So this reads the shipped source of the hosts (both adapters, the ControlPlaneDO and the
 * vertical host) for a SEAT, any of:
 * 1. a string forming a role tuple's relation: `` `role:${…}` `` or `'role:' + …`;
 * 2. SQL writing the role table: `INSERT … INTO _substrat_roles`, `REPLACE INTO _substrat_roles`,
 *    `UPDATE _substrat_roles`;
 * 3. a call of the kernel's scope-role writers, `applyScopeRoleChange(` and `changeScopeRole(`;
 * 4. a call of a ScopeDO's role projection, `.applyProjection(`, `.applyProjectionReply(` and
 *    `.projectRole(`, each of which defines the roles it is handed in the scope. The ScopeDO's
 *    one-role `projectRole` RPC was removed (#2531); the name stays matched so a new one is caught.
 *
 * Each seat must be covered by a GUARD of its own kind — before it, in its function or one
 * enclosing it (`attachment-writers.mjs`'s `covers`) — or sit in a function listed in `ALLOWED`, keyed
 * `path#function`, with the reason it seats nothing a person is given: a revoke or a tombstone
 * (it takes a role away), a projection of definitions the directory already judged when they
 * were written (re-judging there would drop a stored role and so revoke its seats, #2447), or the
 * primitive a guarded door calls. An entry whose function no longer seats anything is refused
 * too, so the list cannot rot into blanket cover.
 *
 * A guard is held as narrowly as text allows:
 * - **its kind matches the seat.** A role tuple and a kernel scope-role writer (1, 3) are SEATS,
 *   covered by `reservedRoleRefusal` and the wrappers that ask it; a role-table write and a
 *   projection (2, 4) are DEFINITIONS, covered by `reservedRoleDefinitionRefusal`,
 *   `reservedRoleSetRefusal` and theirs. So an owner seat's refusal does not cover the role set
 *   projected beside it.
 * - **its answer is acted on.** A guard that answers (rather than throws) counts only where its
 *   result is assigned (`const r = guard(…)`) and then tested by `if (r` before the seat, or
 *   returned. A call whose answer is dropped, or assigned and never tested, covers nothing. The
 *   throwing wrappers (`refuse…`) count as plain calls.
 * What it still does not judge: whether the guard is asked about the role the seat writes.
 *
 * **What this is, and is not.** A regression TRIPWIRE that reads text, not a proof, and it is not
 * meant to be made evasion-proof. Known ways past it, each an innocent refactor away:
 * - a guard on a branch that does not dominate the write (asked in an `if`, written after it);
 * - an answer that is tested but only logged or otherwise ignored, or acted on the wrong way round
 *   (`if (refusal) { write }`, `if (!refusal) return; write`);
 * - a literal hoisted into a constant or split (`const ROLE = 'role:'`, `'role' + ':' + key`), or the
 *   role table named through a constant;
 * - the write moved into a helper in another function, file or package (a kernel helper);
 * - a projection reached by a computed member (`stub['applyProjectionReply'](…)`).
 * Reported when it should not be: a guard asked in another file, or one this reading cannot place. The guarantee is held by the contract
 * suites: `reservedRoleContractSuite` on both adapters and the Cloudflare adapter's
 * `roles a host defines and seats itself (#2447)`. Function names are read off the tokens: the
 * nearest named enclosing function (`function f(`, a method `f(`, `f: async (`, `const f = (`),
 * an anonymous callback counting as part of it.
 *
 * Exit 0: every seat asks first. 1: at least one does not, or an allowlist entry is stale (each
 * printed). Fixtures: `role-seat-paths.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lex } from './bare-regexp.mjs';
import { blankComments, callsOf, covers, functionChains, inScope as shippedSource, lineOf, stringTokenAt } from './attachment-writers.mjs';
import { isMainModule, repoRoot } from './repo-path.mjs';

/** The packages whose code is a host's: where a role is seated or defined for a tenant. */
const HOST_DIRS = ['packages/adapter-sqlite/src/', 'packages/adapter-cloudflare/src/', 'packages/vertical-host/src/'];

export function inScope(path) {
  return HOST_DIRS.some((d) => path.startsWith(d)) && shippedSource(path);
}

/**
 * The reserved-key rule, as a door asks it: the kernel's three and each adapter's wrappers, by the
 * kind of write each covers. `throws` marks a wrapper that refuses by throwing, so calling it is
 * acting on it.
 */
export const GUARDS = {
  reservedRoleRefusal: { kind: 'seat' },
  reservedRoleRefusalFor: { kind: 'seat' },
  reservedRoleRefusalHere: { kind: 'seat' },
  refuseReservedRole: { kind: 'seat', throws: true },
  reservedRoleDefinitionRefusal: { kind: 'definition' },
  reservedRoleSetRefusal: { kind: 'definition' },
  refuseReservedDefinition: { kind: 'definition', throws: true },
  refuseReservedRoleSet: { kind: 'definition', throws: true },
};

/** `path#function` → why that function seats or defines no role a person is given unasked. */
export const ALLOWED = {
  'packages/adapter-sqlite/src/index.ts#revokeTenantRoleAndFence': 'a revoke: it tombstones a role assignment and raises the removal fence',
  'packages/adapter-sqlite/src/index.ts#unassignRole': 'a revoke: it tombstones a scope-level role assignment',
  'packages/adapter-cloudflare/src/host.ts#unassignRole': 'a revoke: it tombstones a role assignment',
  'packages/adapter-cloudflare/src/host.ts#revokeScopeRole': 'a revoke: it tombstones a scope-level role assignment',
  'packages/adapter-cloudflare/src/host.ts#projectScope':
    "a fan-out of the directory's stored definitions, each judged when `defineRole` wrote it; re-judged here, a stored role would be dropped and its seats revoked (#2447)",
  'packages/adapter-cloudflare/src/host.ts#fanOut':
    "a fan-out of the directory's stored definitions, each judged when `defineRole` wrote it; re-judged here, a stored role would be dropped and its seats revoked (#2447)",
  'packages/adapter-cloudflare/src/scope-do.ts#applyProjectionReply': '`applyProjection` with its refusal answered as data: the same write, judged where its caller defines the roles',
  'packages/adapter-cloudflare/src/scope-do.ts#applyProjection':
    "the ScopeDO's write of the role set and seats its coordinator sends, judged where the coordinator defines them (`provisionScopeLocal`, `projectRolesLocal`); a directory fan-out is not re-judged (#2447)",
};

const ROLE_TABLE_WRITE_ALL = /\b(?:(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+["`[]?_substrat_roles\b/gi;
/** A role tuple's relation formed in a string: `` `role:${…}` `` or `'role:' + …`. */
const ROLE_RELATION = /`role:\$\{|['"`]role:['"`]\s*\+/g;
const KERNEL_WRITERS = ['applyScopeRoleChange', 'changeScopeRole'];
const PROJECTIONS = ['applyProjection', 'applyProjectionReply', 'projectRole'];
const NOT_A_NAME = new Set(['async', 'function', 'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'await']);

/** The token index opening each function id (`functionChains` numbers them in order). */
function functionOpenings(t, chains) {
  const open = new Map();
  for (let k = 0; k + 1 < t.length; k += 1) {
    if (t[k].text !== '{') continue;
    const inner = chains[k + 1] ?? [];
    const id = inner[inner.length - 1];
    if (id !== undefined && !chains[k].includes(id) && !open.has(id)) open.set(id, k);
  }
  return open;
}

/** The name of the function whose body opens at `k`, or undefined for an anonymous one. */
function nameAt(t, k) {
  let j = k - 1;
  if (t[j]?.text === '>' && t[j - 1]?.text === '=') j -= 2; // `=>`
  // Back over a return-type annotation to the parameter list's `)`.
  for (let depth = 0; j >= 0; j -= 1) {
    const x = t[j].text;
    if (x === '>' || x === ']' || x === '}') depth += 1;
    else if (depth > 0 && (x === '<' || x === '[' || x === '{')) depth -= 1;
    else if (depth === 0 && x === ')') break;
  }
  for (let paren = 0; j >= 0; j -= 1) {
    if (t[j].text === ')') paren += 1;
    else if (t[j].text === '(' && (paren -= 1) === 0) break;
  }
  let h = j - 1;
  if (t[h]?.text === '>') {
    // A generic parameter list, `f<T>(`.
    for (let depth = 0; h >= 0; h -= 1) {
      if (t[h].text === '>') depth += 1;
      else if (t[h].text === '<' && (depth -= 1) === 0) break;
    }
    h -= 1;
  }
  if (t[h]?.kind === 'word' && t[h].text === 'async') h -= 1;
  const head = t[h];
  if (!head) return undefined;
  if (head.kind === 'word' && !NOT_A_NAME.has(head.text)) return head.text; // `function f(`, a method `f(`
  if ((head.text === ':' || head.text === '=') && t[h - 1]?.kind === 'word') return t[h - 1].text; // `f: (`, `const f = (`
  return undefined;
}

/** The nearest named function enclosing token `k`, or undefined at module level. */
function enclosingName(t, chains, openings, k) {
  const chain = chains[k] ?? [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const name = nameAt(t, openings.get(chain[i]));
    if (name) return name;
  }
  return undefined;
}

/**
 * Where a guard call at token `k` is acted on, or -1 when its answer is dropped: the call itself
 * for a throwing wrapper or a returned answer, else the `if (name` that tests the variable its
 * statement assigns. The statement is found by walking back to its start (a `;`, `{` or `}` at
 * the call's depth), so a guard nested in a ternary or a `.then` callback is still the initializer.
 */
function actedOnAt(t, k, chains) {
  if (GUARDS[t[k].text].throws) return k;
  let st = k - 1;
  for (let depth = 0; st >= 0; st -= 1) {
    const x = t[st].text;
    if (t[st].kind !== 'punct') continue;
    if (depth === 0 && (x === ';' || x === '{' || x === '}')) break;
    if (x === ')' || x === ']' || x === '}') depth += 1;
    else if ((x === '(' || x === '[' || x === '{') && depth > 0) depth -= 1;
  }
  const head = t[st + 1];
  if (head?.text === 'return') return k;
  if (!(head && ['const', 'let', 'var'].includes(head.text) && t[st + 2]?.kind === 'word' && t[st + 3]?.text === '=')) return -1;
  const name = t[st + 2].text;
  const fn = chains[k].at(-1);
  for (let j = k + 1; j < t.length; j += 1) {
    if (!chains[j].includes(fn)) break; // past the guard's function
    // `if (r` or `if (!r`: a write inside `if (!r) { … }` is the admitted branch, so it counts too.
    const open = t[j - 1]?.text === '!' ? j - 2 : j - 1;
    if (t[j].text === name && t[open]?.text === '(' && t[open - 1]?.text === 'if') return j;
  }
  return -1;
}

/** Each seat in a source text: `{ k, line, what, kind }`, `k` its token. */
function seatsOf(text, t) {
  const seats = [];
  // The lexer keeps a string's quote, not its text, so a string seat is found in the text and
  // placed at the string token its line holds (`stringTokenAt`), as `attachment-writers` does.
  for (const [pattern, what, kind] of [
    [ROLE_RELATION, 'a role tuple', 'seat'],
    [ROLE_TABLE_WRITE_ALL, 'a role definition (the role table)', 'definition'],
  ]) {
    for (const m of text.matchAll(pattern)) {
      const line = lineOf(text, m.index);
      const k = stringTokenAt(t, line);
      if (k >= 0) seats.push({ k, line, what, kind });
    }
  }
  for (let k = 0; k < t.length; k += 1) {
    const tok = t[k];
    if (tok.kind === 'word' && t[k + 1]?.text === '(') {
      const prev = t[k - 1]?.text;
      if (KERNEL_WRITERS.includes(tok.text) && prev !== '.' && prev !== 'function') {
        seats.push({ k, line: tok.line, what: `a scope role (${tok.text})`, kind: 'seat' });
      } else if (PROJECTIONS.includes(tok.text) && prev === '.') {
        seats.push({ k, line: tok.line, what: `a role definition (${tok.text})`, kind: 'definition' });
      }
    }
  }
  return seats;
}

/**
 * The offences in `files` ([{ path, text }]), as `path:line: why` strings. `allowed` is the
 * allowlist (`ALLOWED`); every entry must still name a function that seats something.
 */
export function findUnguardedSeats(files, allowed = ALLOWED) {
  const out = [];
  const used = new Set();
  for (const { path, text: source } of files) {
    if (!inScope(path)) continue;
    const text = blankComments(source);
    if (!/role:|_substrat_roles|applyScopeRoleChange|changeScopeRole|applyProjection|projectRole/.test(text)) continue;
    const t = lex(text);
    const chains = functionChains(t);
    const openings = functionOpenings(t, chains);
    // A guard is a call inside a function: a declaration (an interface's, a method's head) sits in
    // none. Each is placed where its answer is acted on, and one whose answer is dropped is no guard.
    const guards = Object.keys(GUARDS).flatMap((g) =>
      callsOf(t, g)
        .filter((k) => chains[k].length > 0 && t[k - 1]?.text !== 'function')
        .map((k) => ({ kind: GUARDS[g].kind, at: actedOnAt(t, k, chains), call: k }))
        .filter((g) => g.at >= 0),
    );
    for (const seat of seatsOf(text, t)) {
      // Covered: a guard of the seat's kind, called in its function (or one enclosing it), whose
      // answer is acted on before the seat.
      if (guards.some((g) => g.kind === seat.kind && covers(chains, g.call, seat.k) && g.at < seat.k)) continue;
      const fn = enclosingName(t, chains, openings, seat.k);
      const key = `${path}#${fn ?? '(module)'}`;
      if (fn && Object.hasOwn(allowed, key)) {
        used.add(key);
        continue;
      }
      out.push(
        `${path}:${seat.line}: ${seat.what} is written in ${fn ?? 'module code'} with no ${seat.kind === 'seat' ? 'reservedRoleRefusal' : 'reservedRoleDefinitionRefusal / reservedRoleSetRefusal'} ` +
          `(or an adapter's wrapper of one) acted on before it`,
      );
    }
  }
  for (const key of Object.keys(allowed)) {
    const [path] = key.split('#');
    if (files.some((f) => f.path === path) && !used.has(key)) {
      out.push(`${key}: an ALLOWED entry whose function seats nothing unguarded any more — remove it`);
    }
  }
  return out;
}

/** The tracked source files the rule reads. */
function trackedFiles(root) {
  const listed = execFileSync('git', ['ls-files', '--', ...HOST_DIRS], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return listed.filter(inScope).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}

if (isMainModule(import.meta.url)) {
  const root = repoRoot(import.meta.url);
  const files = trackedFiles(root);
  const offences = findUnguardedSeats(files);
  if (offences.length > 0) {
    console.error(`role-seat-paths: ${offences.length} role seat(s) or definition(s) without the reserved-key rule (#2447):\n`);
    for (const o of offences) console.error(`  ${o}`);
    console.error(
      "\nAsk the kernel's rule before the write: reservedRoleRefusal(role, reserved, 'person' | 'platform') for a seat,\n" +
        'reservedRoleDefinitionRefusal / reservedRoleSetRefusal for a definition. A function that only takes a role away,\n' +
        'or projects definitions the directory already judged, goes in ALLOWED (tools/role-seat-paths.mjs) with its reason.',
    );
    process.exit(1);
  }
  console.log(`role-seat-paths: every role seat and definition in ${files.length} host source files asks the reserved-key rule first`);
}
