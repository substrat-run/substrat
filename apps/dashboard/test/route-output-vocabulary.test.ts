import { describe, expect, it } from 'vitest';
import { z } from '@substrat-run/contracts';
import { dashboardRoutes } from '../src/routes.js';

/**
 * #2401: the rule every declared route's output follows (`routes.ts`, VERSION SKEW): an enum the
 * control plane owns is a `string` there, because the plane ships separately and may answer a value
 * this dashboard's contracts do not know. `.extend` widens only what it names, so an enum that
 * contracts later adds to a row the dashboard builds on would arrive closed, and the plane's next
 * value would fail the route again, after the write for a write.
 *
 * So this walks every declared output and names each closed vocabulary (an enum or a literal) left
 * in it. Each must be listed below with why it is not the plane's. A block that falls back to `null`
 * (`orNull`) is not walked: a value it cannot parse already reads as "cannot show".
 */
const OWN_APP_ROW = 'an app row of the dashboard scope’s own table';
const ACK = 'a literal the handler writes itself';
const EXPLANATION_SOURCE = 'the source kinds `explain.ts` writes into the provenance it computes, filed in the team’s own scope (#1749)';

const NOT_THE_PLANES: Record<string, string> = {
  'dashboard/list-apps entries[].status': OWN_APP_ROW,
  'dashboard/install-app status': OWN_APP_ROW,
  'dashboard/retry-app status': OWN_APP_ROW,
  'dashboard/resume-app status': OWN_APP_ROW,
  'dashboard/get-app-integrations providers[].connectFlow': 'the worker advertises only the redirect flow it can serve on this deployment',
  'dashboard/get-app-install-steps [].status': 'an install step the dashboard scope records itself',
  'dashboard/list-app-events entries[].kind': 'the dashboard scope’s own event kinds (`APP_EVENT_KINDS`, held to its CHECK)',
  'dashboard/get-app-auth auth.mode': 'the dashboard scope’s own stored auth shape',
  'dashboard/app-peers calls[].state': 'derived by the dashboard peer disclosure from the tenant directory and peer grants',
  'dashboard/list-members entries[].status': 'the dashboard module’s own roster projection',
  'dashboard/remove-app removed': ACK,
  'dashboard/bind-installed-app bound': ACK,
  'dashboard/revoke-invite revoked': ACK,
  'dashboard/leave-team left': ACK,
  'dashboard/delete-team deleted': ACK,
  'dashboard/promote-deployment promoted': ACK,
  'dashboard/delete-deployment removed': ACK,
  'dashboard/setup-github-ci ok': 'the handler’s own verdict on what GitHub answered',
  'dashboard/setup-github-ci needsPermissions': 'the handler’s own verdict on what GitHub answered',
  'dashboard/get-deployment-traffic markers[].kind': 'derived in this worker from the push and go-live instants',
  'dashboard/business-volumes apps[].unavailable': 'the worker’s own labels for absent versions, moves or a supported read',
  'dashboard/move-scopes refusal.reason': 'read from the plane’s refusal by `rebindReviewReasonIn`, which drops a reason it does not know',
  'dashboard/explanations-status explanation.provenance.sources[].kind': EXPLANATION_SOURCE,
  'dashboard/get-finding-explanation explanation.provenance.sources[].kind': EXPLANATION_SOURCE,
  'dashboard/write-finding-explanation explanation.provenance.sources[].kind': EXPLANATION_SOURCE,
  'dashboard/get-process-note explanation.provenance.sources[].kind': EXPLANATION_SOURCE,
  'dashboard/write-process-note explanation.provenance.sources[].kind': EXPLANATION_SOURCE,
};

interface Def {
  type?: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  innerType?: unknown;
  in?: unknown;
  out?: unknown;
  options?: unknown[];
  keyType?: unknown;
  valueType?: unknown;
}
const defOf = (schema: unknown) => (schema as { _zod: { def: Def } })._zod.def;

/** Leaf schemas with no closed vocabulary below them (including the empty `never` type). */
const OPEN_LEAVES = new Set(['string', 'number', 'boolean', 'unknown', 'null', 'never']);

/**
 * Every closed vocabulary reachable in `schema`, by path (`[]` an array element, `{}` a record's
 * values). A schema type it is not taught throws, so a new one cannot hide a closed set from it.
 */
function closedIn(schema: unknown, path: string, found: string[]): string[] {
  const def = defOf(schema);
  switch (def.type) {
    case 'enum':
    case 'literal':
      found.push(path);
      break;
    case 'object':
      for (const [key, field] of Object.entries(def.shape ?? {})) closedIn(field, path ? `${path}.${key}` : key, found);
      break;
    case 'array':
      closedIn(def.element, `${path}[]`, found);
      break;
    case 'record':
      closedIn(def.keyType, `${path}{key}`, found);
      closedIn(def.valueType, `${path}{}`, found);
      break;
    case 'union':
      for (const option of def.options ?? []) closedIn(option, path, found);
      break;
    case 'pipe':
      closedIn(def.in, path, found);
      closedIn(def.out, path, found);
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'nonoptional':
      closedIn(def.innerType, path, found);
      break;
    case 'catch':
      // `orNull`: what it cannot parse reads as null, so its vocabulary may stay closed.
      break;
    default:
      if (!OPEN_LEAVES.has(def.type ?? '')) throw new Error(`closedIn: a '${def.type}' at '${path}' is not taught here; teach it before it hides a closed set`);
  }
  return found;
}

describe('the declared routes’ outputs (#2401)', () => {
  const closed = Object.entries(dashboardRoutes).flatMap(([name, route]) =>
    'output' in route && route.output !== undefined ? [...new Set(closedIn(route.output, '', []))].map((p) => `${name} ${p}`) : [],
  );

  it('hold no closed vocabulary but the dashboard’s own', () => {
    expect(closed.filter((c) => !Object.hasOwn(NOT_THE_PLANES, c))).toEqual([]);
  });

  it('a schema type the walk is not taught fails it, rather than passing unseen', () => {
    expect(() => closedIn(z.object({ pair: z.tuple([z.string(), z.enum(['a'])]) }), '', [])).toThrow(/'tuple' at 'pair' is not taught/);
    expect(() => closedIn(z.lazy(() => z.string()), '', [])).toThrow(/'lazy'/);
    // The twins: what it is taught still reads, a record's closed keys and a pipe's output side included.
    expect(closedIn(z.record(z.enum(['a', 'b']), z.string()), 'r', [])).toEqual(['r{key}']);
    expect(closedIn(z.string().pipe(z.enum(['x'])), 'p', [])).toEqual(['p']);
  });

  it('list nothing that is no longer there', () => {
    expect(Object.keys(NOT_THE_PLANES).filter((c) => !closed.includes(c))).toEqual([]);
  });
});
