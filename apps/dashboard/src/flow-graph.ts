import type { DeclaredEventSurface } from '@substrat-run/contracts';
import type { ConnectionState } from './flow-findings.js';

/**
 * The flow map (#1234) — the whole wired app, laid out from what the push declares
 * and coloured with what the scope has recorded.
 *
 * The inversion that makes this worth building: Datadog's service map INFERS
 * topology from sampled traffic, so an edge exists only once a request crossed it,
 * and a declared path that never fires is invisible. Substrat declares the map and
 * overlays observations, so silence is a drawn fact — a node the reader can see is
 * there and see has never done anything.
 *
 * A read-only projection, always. The moment a node is draggable-and-saveable this
 * becomes flows-as-data and leaves every gate the platform is built on: the
 * permission diff, the migration review, boundary-lint. Nothing here takes input.
 *
 * ## Why the dashboard and not `@substrat-run/model-view`
 *
 * model-view renders ONE artifact into a self-contained page with no script and no
 * network, which is exactly right for the ER diagram: a `model.json` is complete on
 * its own, and the page is openable from a file path. This graph is not that. Its
 * colour comes from live per-scope facts that only the dashboard can read, and a
 * no-script `srcdoc` iframe can never link a node to its exemplars — the thing
 * #1231 asks every aggregate in this cluster to do. So the layout lives here, pure
 * and tested, and the tab draws it as ordinary SVG.
 *
 * ## What the bands are, and the one honest gap in them
 *
 * The issue asks for `triggers → operations → events → consumers → connections →
 * egress`. Four of those are on the manifest. **Operations are not**: `model.json`
 * carries entities and lifecycles only, and `declaredEvents` names the MODULE that
 * emits a type, never the operation inside it. So the second band is modules, and
 * the graph does not pretend to know which operation emitted what. Naming that here
 * rather than drawing a plausible-looking edge nobody can check.
 */
export type FlowNodeKind = 'trigger' | 'module' | 'event' | 'connection' | 'egress';

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  /** What the node is called on screen. */
  label: string;
  /** The second line — a cadence, a module's role, a connection's status. */
  sublabel: string | null;
  /**
   * The observed count for an event node: how many of this type the scope's outbox
   * holds. `null` on every other kind, and on an event node when the observation
   * could not be completed — which is NOT the same as zero and must not render as it.
   */
  observed: number | null;
  /**
   * True only when the observation is trustworthy AND found nothing. This is the
   * finding the whole view exists for, so it is a field rather than an inference
   * from `observed === 0`: an incomplete observation also yields no count, and
   * would otherwise be drawn as proven silence.
   */
  silent: boolean;
  /** Set when the node is in a state worth colouring — an unusable connection. */
  status: 'ok' | 'warn' | 'danger';
  /** A sentence for the tooltip; never a claim the data does not support. */
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** `emits` points down the bands; `consumes` points back up and is drawn dashed. */
  kind: 'triggers' | 'emits' | 'consumes' | 'uses';
  title: string;
}

export interface FlowGraph {
  /**
   * False when the running version predates the declared-event surface — the same
   * flag the findings list carries, and for the same reason: a graph drawn without
   * declarations would show an app that emits nothing, confidently and wrongly.
   */
  available: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
  /**
   * True when any event node's `observed` is null because the facet was truncated.
   * The legend has to say so — otherwise an uncounted node reads as a quiet one.
   */
  partialObservation: boolean;
  /**
   * True when the DECLARED surface was cut at the manifest's cap, so the map is a
   * sample of the app rather than the app.
   *
   * The header on this card claims to draw "what this app declares", which under a
   * truncated declaration is a claim about modules and event types that are simply not
   * in the picture — and unlike a missing count, a missing NODE leaves nothing behind to
   * notice. Carried so the view can say so; the drawing itself is unaffected, since every
   * node it does draw was really declared.
   */
  declaredComplete: boolean;
}

const BAND_GAP = 108;
const NODE_H = 44;
const COL_GAP = 22;
const PAD = 18;
/** Where a band wraps. Near a laptop's window, so labels stay readable rather than shrinking. */
const MAX_WIDTH = 1000;

const widthFor = (label: string, sublabel: string | null): number =>
  Math.max(120, Math.min(260, Math.max(label.length, (sublabel ?? '').length) * 7 + 24));

/**
 * Lay the bands out top to bottom, wrapping a band that would run past `MAX_WIDTH`
 * onto further lines. A wrapped line stays inside its own band, so an edge between
 * two bands still always points at a different one.
 */
function layout(bands: Omit<FlowNode, 'x' | 'y' | 'w' | 'h'>[][]): { nodes: FlowNode[]; width: number; height: number } {
  const nodes: FlowNode[] = [];
  let width = 0;
  let line = 0;
  for (const band of bands) {
    if (band.length === 0) continue;
    let x = PAD;
    band.forEach((n, i) => {
      const w = widthFor(n.label, n.sublabel);
      if (i > 0 && x + w + PAD > MAX_WIDTH) {
        line += 1;
        x = PAD;
      }
      nodes.push({ ...n, x, y: PAD + line * BAND_GAP, w, h: NODE_H });
      x += w + COL_GAP;
      width = Math.max(width, x - COL_GAP + PAD);
    });
    line += 1;
  }
  const height = line === 0 ? 0 : PAD * 2 + (line - 1) * BAND_GAP + NODE_H;
  return { nodes, width, height };
}

export interface DeclaredSchedule {
  operation: string;
  cadence: { everyMinutes: number };
  moduleId: string;
}

export interface ObservedType {
  type: string;
  count: number;
}

/**
 * Build the flow map from one version's declarations and its scope's recorded events.
 *
 * The observed side comes from faceting the outbox by `type` (#1239), which sees only
 * what is still IN the outbox. That is a window, not all of history — so a node marked
 * silent says "nothing recorded", never "never happened".
 */
export function deriveFlowGraph(input: {
  /** Null = the running version predates the declared-event surface. */
  declaredEvents: DeclaredEventSurface[] | null;
  schedules: readonly DeclaredSchedule[];
  requires: readonly string[];
  knownProviders: readonly string[];
  connections: readonly ConnectionState[];
  outbound: readonly string[];
  observed: readonly ObservedType[];
  /** False when the facet was truncated, so a missing type proves nothing. */
  observedComplete: boolean;
  /** False when the manifest says its declared surface was cut at the cap (#1234). */
  declaredComplete: boolean;
}): FlowGraph {
  const {
    declaredEvents,
    schedules,
    requires,
    knownProviders,
    connections,
    outbound,
    observed,
    observedComplete,
    declaredComplete,
  } = input;
  if (declaredEvents === null) {
    return {
      available: false,
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      partialObservation: false,
      declaredComplete,
    };
  }

  const counts = new Map(observed.map((o) => [o.type, o.count]));
  const known = new Set(knownProviders);
  const edges: FlowEdge[] = [];

  // Band 1 — triggers. Every declared schedule, plus the request path, which is not
  // declared anywhere: an app with routes always has it, and leaving it out would draw
  // an app whose modules nothing reaches.
  const triggers: Omit<FlowNode, 'x' | 'y' | 'w' | 'h'>[] = [
    {
      id: 'trigger:http',
      kind: 'trigger',
      label: 'HTTP requests',
      sublabel: 'on demand',
      observed: null,
      silent: false,
      status: 'ok',
      title:
        'Requests to this app’s own routes. Drawn unattached on purpose: which module serves a request is an operation-level fact, and the push does not declare operations — so there is no edge here that could be checked.',
    },
    ...schedules.map((s) => ({
      id: `trigger:schedule:${s.moduleId}:${s.operation}`,
      kind: 'trigger' as const,
      label: s.operation,
      sublabel: cadenceLabel(s.cadence.everyMinutes),
      observed: null,
      silent: false,
      status: 'ok' as const,
      title: `A declared schedule: ${s.moduleId} runs ${s.operation} ${cadenceLabel(s.cadence.everyMinutes)}. Whether it has actually run is on the schedule-health card.`,
    })),
  ];

  // Band 2 — modules. Every module that declares an event or a schedule. Operations
  // would belong here, and the manifest does not carry them (see the header).
  const moduleIds = [...new Set([...declaredEvents.map((d) => d.moduleId), ...schedules.map((s) => s.moduleId)])].sort();
  const modules = moduleIds.map((id) => {
    const emits = declaredEvents.filter((d) => d.moduleId === id && d.direction === 'emits').length;
    const consumes = declaredEvents.filter((d) => d.moduleId === id && d.direction === 'consumes').length;
    return {
      id: `module:${id}`,
      kind: 'module' as const,
      label: id,
      sublabel: `${emits} emitted · ${consumes} handled`,
      observed: null,
      silent: false,
      status: 'ok' as const,
      title: `${id} declares ${emits} emitted event ${emits === 1 ? 'type' : 'types'} and handles ${consumes}.`,
    };
  });

  for (const s of schedules) {
    edges.push({
      from: `trigger:schedule:${s.moduleId}:${s.operation}`,
      to: `module:${s.moduleId}`,
      kind: 'triggers',
      title: `${s.operation} runs inside ${s.moduleId}`,
    });
  }
  // The HTTP trigger is deliberately UNCONNECTED.
  //
  // It used to draw an edge to every module, on the reasoning that requests reach them
  // all. They do not: `ModuleRegistration.operations` is optional, and a consumer-only or
  // schedule-only module is reached by an event or the clock and never by a request. The
  // edge was therefore the plausible-looking-but-uncheckable line this file's header
  // disavows, drawn `modules.length` times.
  //
  // Which module serves a request is an OPERATION fact, and operations are exactly what
  // the manifest does not carry (header, "the one honest gap"). So the node stays, because
  // requests really do arrive, and it stays unattached until something declares where they
  // land — the node's own title says so rather than a line implying an answer.

  // Band 3 — events. The declared types, each carrying what the scope has recorded.
  const types = [...new Set(declaredEvents.map((d) => d.type))].sort();
  let partialObservation = false;
  const events = types.map((type) => {
    const count = observedComplete ? (counts.get(type) ?? 0) : (counts.get(type) ?? null);
    if (count === null) partialObservation = true;
    const silent = observedComplete && count === 0;
    return {
      id: `event:${type}`,
      kind: 'event' as const,
      label: type,
      sublabel: count === null ? 'not counted' : count === 0 ? 'none recorded' : `${count.toLocaleString()} recorded`,
      observed: count,
      silent,
      status: 'ok' as const,
      title: silent
        ? `${type} is declared and none has been recorded. The path may never run, or nobody may have exercised it yet.`
        : count === null
          ? `${type} is declared. This app has recorded more distinct types than could be counted in one pass, so this one has no count — which is not the same as none.`
          : `${type}: ${count.toLocaleString()} recorded in this app’s events.`,
    };
  });

  for (const d of declaredEvents) {
    edges.push(
      d.direction === 'emits'
        ? { from: `module:${d.moduleId}`, to: `event:${d.type}`, kind: 'emits', title: `${d.moduleId} emits ${d.type}` }
        : { from: `event:${d.type}`, to: `module:${d.moduleId}`, kind: 'consumes', title: `${d.moduleId} handles ${d.type}` },
    );
  }

  // Band 4 — the outside. Providers this version requires, and the hosts it may reach.
  const providers = [...new Set(requires)].filter((p) => known.has(p)).sort();
  const outside: Omit<FlowNode, 'x' | 'y' | 'w' | 'h'>[] = [
    ...providers.map((provider) => {
      const forProvider = connections.filter((c) => c.provider === provider);
      const live = forProvider.some((c) => c.status === 'active');
      const status: FlowNode['status'] = live ? 'ok' : forProvider.length === 0 ? 'warn' : 'danger';
      return {
        id: `connection:${provider}`,
        kind: 'connection' as const,
        label: provider,
        sublabel: live ? 'connected' : forProvider.length === 0 ? 'not connected' : 'needs reconnecting',
        observed: null,
        silent: false,
        status,
        title: live
          ? `${provider} is connected.`
          : forProvider.length === 0
            ? `This app is set up to use ${provider}, and nobody has connected it. Work that needs it waits rather than failing.`
            : `${provider} is connected but not usable (${[...new Set(forProvider.map((c) => c.status))].sort().join(', ')}).`,
      };
    }),
    ...[...new Set(outbound)].sort().map((host) => ({
      id: `egress:${host}`,
      kind: 'egress' as const,
      label: host,
      sublabel: 'declared egress',
      observed: null,
      silent: false,
      status: 'ok' as const,
      // Deliberately makes no claim about use: nothing counts egress per host today,
      // so "nothing has used this" is a finding this graph cannot yet support.
      title: `${host} is on this version’s outbound allowlist — a host it is permitted to reach.`,
    })),
  ];

  // No edges into the outside band, deliberately. `requires` and `outbound` are
  // declared by the VERTICAL, not by a module, so an edge from any particular module
  // would be invented — and an edge from every module would assert the same thing
  // about each of them. Band membership already carries the whole declared fact:
  // this app is permitted to reach these. Which module does is #1237's question,
  // answerable from a trace, not from a manifest.

  const { nodes, width, height } = layout([triggers, modules, events, outside]);
  return { available: true, nodes, edges, width, height, partialObservation, declaredComplete };
}

function cadenceLabel(everyMinutes: number): string {
  if (everyMinutes % 1440 === 0) {
    const d = everyMinutes / 1440;
    return d === 1 ? 'daily' : `every ${d} days`;
  }
  if (everyMinutes % 60 === 0) {
    const h = everyMinutes / 60;
    return h === 1 ? 'hourly' : `every ${h} hours`;
  }
  return `every ${everyMinutes} min`;
}
