import { z } from 'zod';

/**
 * The tuple-ref grammar, `<namespace>:<id>`, in ONE place (#1856).
 *
 * Its own module, importing nothing but zod, because two schemas that must agree need it
 * and they cannot import each other: `permission.ts` (the walk's `objectRef`, and the
 * write-side check) already imports `events.ts`, and `events.ts` records a grant's object
 * in an event's `authorization`. A second spelling of the pattern is how #1856 happened
 * twice: the walk refused a camelCase type, and so did the event envelope.
 *
 * The namespace half admits upper case, because an entity type is a module's own name for
 * a thing and those are camelCase (`aiTurn`, `widgetSession`). Upper case is the only
 * addition to what it accepted before. The id half is anything but whitespace.
 */
const NAMESPACE = '[A-Za-z0-9_-]+';
const ID = '[^\\s]+';

/** One namespace half on its own: the entity type a write is held to. */
export const OBJECT_NAMESPACE = new RegExp(`^${NAMESPACE}$`);
/** One id half on its own. */
export const OBJECT_ID = new RegExp(`^${ID}$`);

/**
 * The namespaces the kernel writes tuples under: the node objects, the role subjects of a
 * proof, and every `CheckSubject` kind. An entity type spelled as one of these, in any
 * case, would share its prefix with kernel rows. Lower case here; compared lower-cased.
 *
 * Here rather than in `permission.ts` so the manifest and model schemas can refuse the same
 * names (#1869) without importing the permission module.
 */
export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  'principal',
  'org',
  'tenant',
  'scope',
  'role',
  'connection',
  'capability',
  'system',
  'vertical',
]);

/** Whether `name` is a kernel namespace in any case: `scope`, `Scope` and `SCOPE` all are. */
export function isKernelNamespace(name: string): boolean {
  return RESERVED_NAMESPACES.has(name.toLowerCase());
}

/**
 * A tuple end, unbranded: for a schema that records one (an event's `authorization.grant`)
 * without making every producer of it hold the `ObjectRef` brand.
 */
export const objectRefString = z.string().regex(new RegExp(`^${NAMESPACE}:${ID}$`));
