/**
 * One layout for every engine state machine on the docs site.
 *
 * The five engine pages drew their machines as ASCII, five times, by hand. The
 * shapes were identical — a spine from the initial state plus branches falling
 * off it — and the drawings could disagree with the code with nothing noticing.
 *
 * Two things separate here. The **machine** is the data: for engines that
 * declare a lifecycle it is read straight from the emitted `model.json`, which
 * `lint:model --check` already gates, so the diagram cannot drift from the code.
 * For engines that do not declare one yet it is written out in the same shape —
 * so when they do, the call swaps to `fromModel` and nothing else changes.
 *
 * The **layout** is derived here, the same way for both. Nothing is positioned
 * by hand, and nothing is positioned by a general-purpose graph algorithm
 * either: these machines are a chain with branches, so the layout that reads
 * best is the one that says so.
 */

export interface MachineState {
  readonly on?: Readonly<Record<string, string>>;
  readonly allow?: readonly string[];
  readonly terminal?: boolean;
  readonly extensible?: boolean;
}

export interface Machine {
  readonly field: string;
  readonly initial: string;
  readonly states: Readonly<Record<string, MachineState>>;
}

/** Pull one entity's machine out of an emitted `model.json`. */
export function fromModel(
  model: { lifecycles?: Record<string, Machine> },
  entity: string,
): Machine {
  const machine = model.lifecycles?.[entity];
  if (!machine) throw new Error(`model.json declares no lifecycle for '${entity}'`);
  return machine;
}

/**
 * `workorder/report-time` → `report-time`.
 *
 * The engine prefix is the same on every edge of a given machine, so printing it
 * costs width and says nothing. The full id stays in the twin.
 */
export const verb = (operationId: string): string =>
  operationId.includes('/') ? operationId.slice(operationId.indexOf('/') + 1) : operationId;

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly op: string;
}

export interface Layout {
  /** The longest run of states from `initial`, laid out top to bottom. */
  readonly spine: readonly string[];
  /** Edges along the spine, one per gap between consecutive spine states. */
  readonly spineEdges: readonly Edge[];
  /** Edges leaving the spine for a state that is not on it — drawn to the right. */
  readonly branches: readonly Edge[];
  /** Edges rejoining the spine out of order — a skip ahead or a loop back. */
  readonly rejoins: readonly Edge[];
}

const edgesOf = (m: Machine): Edge[] =>
  Object.entries(m.states).flatMap(([from, s]) =>
    Object.entries(s.on ?? {}).map(([op, to]) => ({ from, to, op })),
  );

/**
 * The longest simple path from `initial`.
 *
 * Longest rather than first-found because the spine should be the story the
 * machine is mostly about: `held → confirmed → in_service → completed`, with
 * `expired` hanging off it — not `held → expired`, which is true, shorter, and
 * a terrible summary. Exponential in principle, trivial at five states.
 */
function longestPath(m: Machine, edges: readonly Edge[]): string[] {
  const walk = (at: string, seen: readonly string[]): string[] => {
    const next = edges
      .filter((e) => e.from === at && !seen.includes(e.to))
      .map((e) => walk(e.to, [...seen, e.to]));
    return next.reduce((best, p) => (p.length > best.length ? p : best), [] as string[]).length
      ? [at, ...next.reduce((b, p) => (p.length > b.length ? p : b), [] as string[])]
      : [at];
  };
  return walk(m.initial, [m.initial]);
}

export function layout(m: Machine): Layout {
  const edges = edgesOf(m);
  const spine = longestPath(m, edges);
  const onSpine = new Set(spine);

  const spineEdges: Edge[] = [];
  for (let i = 0; i < spine.length - 1; i++) {
    const e = edges.find((x) => x.from === spine[i] && x.to === spine[i + 1]);
    if (e) spineEdges.push(e);
  }

  const rest = edges.filter((e) => !spineEdges.includes(e));
  return {
    spine,
    spineEdges,
    branches: rest.filter((e) => !onSpine.has(e.to)),
    rejoins: rest.filter((e) => onSpine.has(e.to)),
  };
}

/** The markdown twin of a machine — the same layout, stated rather than drawn. */
export function altFrom(m: Machine, title: string): string {
  const l = layout(m);
  const lines: string[] = [
    `**Diagram — the ${title} state machine**, on \`${m.field}\`, starting at ` +
      `\`${m.initial}\`.`,
    '',
    `- **The main run:** ${l.spine
      .map((s, i) => (i === 0 ? `\`${s}\`` : `→ *${verb(l.spineEdges[i - 1]!.op)}* → \`${s}\``))
      .join(' ')}`,
  ];
  for (const e of l.branches) {
    lines.push(`- **Leaves the run:** \`${e.from}\` → *${verb(e.op)}* → \`${e.to}\`.`);
  }
  for (const e of l.rejoins) {
    lines.push(`- **Rejoins:** \`${e.from}\` → *${verb(e.op)}* → \`${e.to}\`.`);
  }
  const allowed = Object.entries(m.states)
    .filter(([, s]) => s.allow?.length)
    .map(([name, s]) => `\`${name}\` admits ${s.allow!.map((o) => `*${verb(o)}*`).join(', ')}`);
  if (allowed.length) {
    lines.push('', `**Permitted without moving:** ${allowed.join('; ')}.`);
  }
  const terminal = Object.entries(m.states).filter(([, s]) => s.terminal).map(([n]) => `\`${n}\``);
  if (terminal.length) lines.push(`**Terminal:** ${terminal.join(', ')}.`);
  lines.push(
    '',
    'An operation the machine has never heard of is not forbidden — it is not governed. ' +
      'Absence means "no state gates this", never "denied".',
  );
  return lines.join('\n');
}
