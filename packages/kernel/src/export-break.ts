import { errorCodeOf, substratError } from '@substrat-run/contracts';
import type { ExportBreak, ManifestExports, ManifestImports, PlatformActorId, Scope, TenantId } from '@substrat-run/contracts';
import type { HostAdmin } from './scope-host.js';
import { mapBounded, message } from './map-bounded.js';
import { isPrimaryScope, runningVersionOf, servingPointersFor, type ServingPointer } from './scope-identity.js';

/**
 * The export-break gate (#1705 PR 3, #1756): whom a promote, a bind or a route change breaks,
 * judged by each adapter's promote and bind doors, and the refusals they answer with.
 * Split out of `platform-sweep.ts` (#1978).
 */

/**
 * What each scope's RUNNING version imports, from the registry (#1705): one `listVerticals` when
 * a scope is on a serving script, then one `readImports` per distinct running version, at most
 * `concurrency` in flight. A failure on one version never stops the others: a read that throws is
 * reported as `threw` beside the fact, since a caller may treat "the registry could not be asked"
 * differently from "the manifest does not parse". A scope bound to no version gets no fact. The narrowing and the promote gate
 * both ask it, so the two cannot come to disagree about which code a scope runs.
 */
export async function runningImportsOf(
  admin: Pick<HostAdmin, 'listVerticals'>,
  actor: PlatformActorId,
  scopes: readonly Scope[],
  readImports: (verticalSlug: string, versionId: string) => Promise<ManifestImports>,
  concurrency: number,
): Promise<{ scope: Scope; key: string; versionId: string | null; fact: ManifestImports | undefined; threw?: string }[]> {
  return runningFactsOf(admin, actor, scopes, readImports, (reason) => ({ kind: 'unreadable', reason }), concurrency);
}

/**
 * {@link runningImportsOf} for any fact a stored manifest carries (#2316 reads connection landings
 * through it): one read per distinct running version, `unreadable(reason)` standing in for a read
 * that threw. One walk, so every reader agrees about which code a scope runs.
 */
export async function runningFactsOf<F>(
  admin: Pick<HostAdmin, 'listVerticals'>,
  actor: PlatformActorId,
  scopes: readonly Scope[],
  read: (verticalSlug: string, versionId: string) => Promise<F>,
  unreadable: (reason: string) => F,
  concurrency: number,
): Promise<{ scope: Scope; key: string; versionId: string | null; fact: F | undefined; threw?: string }[]> {
  const serving = await servingPointersFor(admin, actor, scopes);
  const versions = new Map<string, { slug: string; versionId: string }>();
  const keyed: { scope: Scope; key: string; versionId: string | null }[] = [];
  for (const s of scopes) {
    if (!s.vertical) continue;
    const versionId = runningVersionOf(s, serving.get(s.vertical));
    const key = `${s.vertical}@${versionId ?? '(no version)'}`;
    if (versionId && !versions.has(key)) versions.set(key, { slug: s.vertical, versionId });
    keyed.push({ scope: s, key, versionId });
  }
  const facts = new Map<string, F>();
  const threw = new Map<string, string>();
  await mapBounded([...versions], concurrency, async ([key, v]) => {
    try {
      facts.set(key, await read(v.slug, v.versionId));
    } catch (err) {
      facts.set(key, unreadable(message(err)));
      threw.set(key, message(err));
    }
  });
  return keyed.map((k) => ({ ...k, fact: facts.get(k.key), ...(threw.has(k.key) ? { threw: threw.get(k.key)! } : {}) }));
}

/**
 * Who a promote breaks (#1705 PR 3): the installed consumers whose RUNNING code imports an
 * exported (type, schemaVersion) that the outgoing version promised and the incoming one drops
 * or exports at another version. The promote gate refuses on a non-empty answer unless it is
 * acknowledged (`exportBreak`), and the refusal lists them.
 *
 * - **What changed** is outgoing versus incoming, from the two versions' registries. An outgoing
 *   version whose registry states no exports (a first promote, or a push by a CLI older than
 *   0.34.0) promised nothing the registry can name, so nothing is judged broken. Nothing it
 *   exported at run time could be listed either, which is what the permission-digest gate
 *   beside this one is for.
 * - **Who is a consumer** is the edge's own rule: a primary, active scope of ANOTHER vertical, in
 *   a tenant where the producer is installed (any primary, active install, so two installs still
 *   count), whose running version (`runningVersionOf`) declares the import. That over-approximates
 *   on purpose, for a listed vertical's tenants still pinned to an older producer version: a
 *   refusal that names one tenant too many costs an acknowledgement, and one that names too few
 *   costs a silent stall.
 * - **A consumer version whose manifest does not parse** is not judged. It cannot be said to
 *   break, and refusing every promote over a manifest nobody can parse would make the gate one
 *   nobody can pass. A read that THREW is different: the registry could not be asked, so whom the
 *   promote breaks is unknown, and this throws. The gate then refuses rather than failing open.
 *   A failed directory read throws the same way.
 *
 * Cost: nothing at all unless an export changed. Then one fleet `listScopes`, one
 * `listVerticals` when a scope is on a serving script, and one `readImports` per distinct
 * running consumer version, at most `concurrency` in flight.
 */
export async function exportBreaksOf(input: {
  admin: Pick<HostAdmin, 'listScopes' | 'listVerticals'>;
  actor: PlatformActorId;
  producer: string;
  outgoing: ManifestExports;
  incoming: ManifestExports;
  readImports: (verticalSlug: string, versionId: string) => Promise<ManifestImports>;
  concurrency?: number;
  /**
   * #1756: judge ONE tenant's consumers only — a bind moves one install, and an edge never
   * crosses a tenant, so no other tenant's app can be broken by it. The tenant is taken to run
   * the producer (the scope being bound is that install), whatever its status.
   */
  tenantId?: TenantId;
  /** What is being judged, for the wording of a refusal to judge it. Default `'promotion'`. */
  act?: 'promotion' | 'bind';
}): Promise<ExportBreak[]> {
  const act = input.act ?? 'promotion';
  // An outgoing manifest that does not parse promised SOMETHING nobody can read. Judging it as
  // "promised nothing" would pass every break unacknowledged, so it refuses, as a thrown read does.
  if (input.outgoing.kind === 'unreadable') {
    throw substratError(
      'unavailable',
      `cannot say whom this ${act} breaks: the outgoing version's exports could not be read (${input.outgoing.reason})`,
    );
  }
  if (input.outgoing.kind !== 'exports') return [];
  const incoming = new Map(input.incoming.kind === 'exports' ? input.incoming.rows.map((r) => [r.type, r.schemaVersion]) : []);
  const changed = new Map<string, { schemaVersion: number; incoming: number | null }>();
  for (const r of input.outgoing.rows) {
    const now = incoming.get(r.type) ?? null;
    if (now !== r.schemaVersion) changed.set(r.type, { schemaVersion: r.schemaVersion, incoming: now });
  }
  if (changed.size === 0) return [];

  const scopes = (await input.admin.listScopes(input.actor, { status: 'active', tenantId: input.tenantId })).filter(
    (s): s is Scope & { vertical: string } => isPrimaryScope(s) && s.vertical !== null,
  );
  // Narrowed to one tenant, every scope read is already in a tenant that runs the producer.
  const installedIn =
    input.tenantId === undefined
      ? new Set(scopes.filter((s) => s.vertical === input.producer).map((s) => s.tenantId as string))
      : null;
  const consumers = scopes.filter((s) => s.vertical !== input.producer && (installedIn?.has(s.tenantId) ?? true));
  if (consumers.length === 0) return [];
  const out: ExportBreak[] = [];
  for (const { scope, key, versionId, fact, threw } of await runningImportsOf(
    input.admin,
    input.actor,
    consumers,
    input.readImports,
    input.concurrency ?? 8,
  )) {
    if (threw !== undefined) {
      throw substratError(
        'unavailable',
        `cannot say whom this ${act} breaks: the registry could not be asked what ${key} imports (${threw}) — retry`,
      );
    }
    if (fact?.kind !== 'imports') continue;
    for (const row of fact.rows) {
      const hit = row.from === input.producer ? changed.get(row.type) : undefined;
      if (!hit || hit.schemaVersion !== row.schemaVersion) continue;
      out.push({
        tenantId: scope.tenantId,
        scopeId: scope.id,
        vertical: scope.vertical as ExportBreak['vertical'],
        version: versionId,
        type: row.type,
        schemaVersion: row.schemaVersion,
        incoming: hit.incoming,
      });
    }
  }
  return out.sort(
    (a, b) => a.tenantId.localeCompare(b.tenantId) || a.scopeId.localeCompare(b.scopeId) || a.type.localeCompare(b.type),
  );
}

/**
 * #2540: whether a throw is `exportBreaksOf`'s refusal to judge (`unavailable`, "cannot say whom
 * this … breaks"). Its sentence names what could not be read, which may be another tenant's app and
 * the read's own error, so a door answering it phrases it for its caller.
 */
export function isExportBreakUnjudged(err: unknown): boolean {
  return errorCodeOf(err) === 'unavailable' && err instanceof Error && err.message.startsWith('cannot say whom this ');
}

/** How `exportBreakRefusal` begins: what lets the promote route recognise it and add the listing. */
const EXPORT_BREAK_REFUSAL = 'promotion drops or re-versions';

/** Whether a throw is the promote gate's export-break refusal (`exportBreakRefusal`). */
export function isExportBreakRefusal(err: unknown): err is Error {
  return errorCodeOf(err) === 'precondition_failed' && err instanceof Error && err.message.startsWith(EXPORT_BREAK_REFUSAL);
}

/**
 * The refusal a promote gets for a non-empty `exportBreaksOf` (#1705 PR 3). Counts only: the
 * adapters do not know who is promoting, and a builder must not learn from an error which other
 * tenants import its events. The route that knows the caller lists what they may see.
 */
export function exportBreakRefusal(breaks: readonly ExportBreak[]): string {
  const types = new Set(breaks.map((b) => b.type)).size;
  const apps = new Set(breaks.map((b) => b.scopeId)).size;
  const tenants = new Set(breaks.map((b) => b.tenantId)).size;
  return (
    `${EXPORT_BREAK_REFUSAL} ${types} exported event type(s) that ${apps} installed app(s) in ` +
    `${tenants} tenant(s) import — their edges would stop delivering it. Acknowledge it explicitly ` +
    `(exportBreak) to promote, or keep the export and bump its consumers first`
  );
}

/** How `bindExportBreakRefusal` begins: what lets the bind route recognise it (#1756). */
export const BIND_EXPORT_BREAK_REFUSAL = 'this bind drops or re-versions';

/** Whether a throw is the bind gate's export-break refusal (`bindExportBreakRefusal`). */
export function isBindExportBreakRefusal(err: unknown): err is Error {
  return errorCodeOf(err) === 'precondition_failed' && err instanceof Error && err.message.startsWith(BIND_EXPORT_BREAK_REFUSAL);
}

/**
 * The refusal a bind gets for a non-empty `bindExportBreaksOf` (#1756). Every break is in the
 * bound scope's own tenant, which the caller addressed, so it names no one else — but it stays in
 * counts, as the promote refusal does, and the route that knows the caller adds the listing.
 */
export function bindExportBreakRefusal(breaks: readonly ExportBreak[]): string {
  const types = new Set(breaks.map((b) => b.type)).size;
  const apps = new Set(breaks.map((b) => b.scopeId)).size;
  return (
    `${BIND_EXPORT_BREAK_REFUSAL} ${types} exported event type(s) that ${apps} installed app(s) in ` +
    `this tenant import — their edges would stop delivering it. Acknowledge it explicitly ` +
    `(exportBreak) to bind, or bind a version that keeps the export`
  );
}

/**
 * What a bind or a route change moves `scope` between (#1756, #2178): the version it runs before
 * and the one it runs after (`runningVersionOf` on both of its inputs), or null when the move
 * changes nothing it runs — a re-point that stays on the serving script — or it ran nothing before
 * (a first bind). `servingRef` omitted: the route is unchanged.
 */
export function scopeMoveOf(
  scope: Pick<Scope, 'verticalVersionId' | 'servingRef'>,
  incomingVersionId: string,
  servingRef: string | null | undefined,
  serving: ServingPointer | null,
): { before: string; after: string } | null {
  const before = runningVersionOf(scope, serving);
  const after = runningVersionOf(
    { verticalVersionId: incomingVersionId, servingRef: servingRef === undefined ? scope.servingRef : servingRef },
    serving,
  );
  return before === null || after === null || before === after ? null : { before, after };
}

/**
 * Whom moving `scope` breaks (#1756): the promote gate's question (`exportBreaksOf`), asked of
 * ONE install in its own tenant, since an edge never crosses one.
 *
 * A scope's exports leave from the code it RUNS, and `runningVersionOf` names that code from two
 * inputs: the version pointer and the serving ref. So a move is either or both of them changing —
 * a bind (`next.versionId`), or a route onto or off a serving script (`next.servingRef`, which is
 * how an adopt moves a scope before its pointer ever does). Both are judged by the same rule, on
 * the running version before against the running version after, the rule the consumers are judged
 * on too:
 *
 * - **Re-pointing a scope that stays on its vertical's serving script** changes nothing it runs,
 *   so it is never refused. The change reached it when the serving script was replaced — at a
 *   promote, which judged every tenant then. A route ONTO the serving script is not that case:
 *   the scope goes from its own version to whatever is served, and that is judged.
 * - **A fork or a preview** is never an edge's producer (`resolveVerticalInstanceFrom` takes the
 *   primary install only), so nothing it runs can break an edge.
 * - **A scope still provisioning** has never been active, so no edge has ever delivered from it.
 * - **A first bind** runs nothing before it, so it promised nothing.
 * - **A lineage crossing** (the version belongs to another vertical than the scope's, or the route
 *   goes onto a script that is not this vertical's serving script) is not judged here, and nothing
 *   else judges it either: every consumer importing `from` the old slug
 *   loses its producer, and `rebind-vertical`'s acknowledgements are about migrations, not about
 *   that. A known gap, older than this gate.
 */
export async function bindExportBreaksOf(input: {
  admin: Pick<HostAdmin, 'listScopes' | 'listVerticals'>;
  actor: PlatformActorId;
  scope: Pick<Scope, 'tenantId' | 'forkedFrom' | 'kind' | 'status' | 'vertical' | 'verticalVersionId' | 'servingRef'>;
  /** The version the scope is bound to after the move (its vertical's slug beside it). */
  incoming: { id: string; verticalSlug: string };
  /** The serving ref it routes by after the move. Omitted: unchanged. */
  servingRef?: string | null;
  /** The serving pointer of the scope's vertical, or null when nothing is served in place. */
  serving: ServingPointer | null;
  readExports: (versionId: string) => Promise<ManifestExports>;
  readImports: (verticalSlug: string, versionId: string) => Promise<ManifestImports>;
}): Promise<ExportBreak[]> {
  const { scope } = input;
  if (!isPrimaryScope(scope) || scope.status === 'provisioning') return [];
  if (scope.vertical === null || scope.vertical !== input.incoming.verticalSlug) return [];
  // A route onto a script that is not this vertical's serving script is a lineage crossing (or a
  // ref this host cannot name), and what the scope runs there is not this vertical's code at all:
  // the same known gap as above, never a phantom move judged against the wrong vertical.
  if (typeof input.servingRef === 'string' && input.servingRef !== input.serving?.ref) return [];
  const move = scopeMoveOf(scope, input.incoming.id, input.servingRef, input.serving);
  if (move === null) return [];
  const [outgoing, incoming] = await Promise.all([input.readExports(move.before), input.readExports(move.after)]);
  return exportBreaksOf({
    admin: input.admin,
    actor: input.actor,
    producer: scope.vertical,
    outgoing,
    incoming,
    readImports: input.readImports,
    tenantId: scope.tenantId,
    act: 'bind',
  });
}
