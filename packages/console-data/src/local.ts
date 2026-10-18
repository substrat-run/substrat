import { emittedModel, requestTrace, type RequestTrace, type TraceHead } from '@substrat-run/contracts';
import { parsePermissions } from '@substrat-run/model-view';
import { REQUEST_FIELDS, type SourceCapabilities } from './capabilities.js';
import { facetsOf, matchesWhere, pageOf } from './query.js';
import type { ConsoleDataSource, RequestQuery, SourceArtifacts, SourceDescription } from './source.js';

/**
 * The local source: what `substrat dev` knows about the vertical in the working tree (#2360).
 *
 * It reads nothing itself. The caller hands it the artifacts (`model.json`, `PERMISSIONS.md`)
 * as it read them, and a {@link TraceReader} over the local trace buffer. That keeps this
 * package free of `node:*` and of the buffer's implementation (#2358), so it runs in a
 * browser, a worker and the dev server alike, and the buffer plugs in when it exists.
 *
 * Everything crossing in is parsed: the model by the contracts' `emittedModel`, each trace by
 * `requestTrace`. A record that does not parse is not a request this source can show, so it
 * is left out rather than drawn half-read.
 */

/** Where the local source reads recorded requests. The trace buffer implements it. */
export interface TraceReader {
  /** Every trace the buffer holds now, in any order. Unparsed: the source parses each. */
  traces(): readonly unknown[] | Promise<readonly unknown[]>;
  /**
   * Call `listener` with each trace as the buffer records it, until the returned function is
   * called. A reader without it gives a source that cannot tail.
   */
  subscribe?(listener: (trace: unknown) => void): () => void;
}

/** The artifacts as the caller read them from the working tree. */
export interface LocalArtifacts {
  /** `model.json`, JSON-parsed; absent when the project has none. */
  readonly modelJson?: unknown;
  /** `PERMISSIONS.md` text; absent when the project has none. */
  readonly permissionsMd?: string;
}

export interface LocalSourceOptions {
  /** The project, as the console names it (a path). */
  readonly label: string;
  /** Read on every `artifacts()` call, so an edit in the working tree shows on the next read. */
  readonly artifacts: () => LocalArtifacts | Promise<LocalArtifacts>;
  /** The trace buffer. Absent, the source holds no requests. */
  readonly traces?: TraceReader;
  /**
   * Hand out the values bound to SQL statements when the recorder kept them. Off by default:
   * a bound value is as likely to be a person's data as an id, and a trace may be read into a
   * model's context.
   */
  readonly rawPayloads?: boolean;
}

/** `model.json` is present and is not a model. */
export class LocalArtifactError extends Error {}

const NO_TRACES: TraceReader = { traces: () => [] };

/** The head alone: the trace's request record. */
export function headOf(trace: RequestTrace): TraceHead {
  const { steps: _steps, capture: _capture, ...head } = trace;
  return head;
}

/** A trace with its bound values removed, saying so in `capture`. */
function withoutRawPayloads(trace: RequestTrace): RequestTrace {
  return {
    ...trace,
    steps: trace.steps.map((s) => {
      if (s.type !== 'sql' || s.params === undefined) return s;
      const { params: _params, ...rest } = s;
      return rest;
    }),
    capture: { ...trace.capture, sqlParams: false },
  };
}

export function createLocalSource(options: LocalSourceOptions): ConsoleDataSource {
  const reader = options.traces ?? NO_TRACES;
  const rawPayloads = options.rawPayloads === true;
  const capabilities: SourceCapabilities = {
    tail: typeof reader.subscribe === 'function',
    rawPayloads,
    exactFacetCounts: true,
    traceSteps: true,
    model: true,
    permissions: true,
    requestFields: REQUEST_FIELDS,
  };
  const description: SourceDescription = { id: `local:${options.label}`, kind: 'local', label: options.label, capabilities };

  // Parsed once per record: a buffer appends, and a changed record is a new object.
  const parsed = new WeakMap<object, RequestTrace | null>();
  const parse = (raw: unknown): RequestTrace | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    let trace = parsed.get(raw);
    if (trace === undefined) {
      const r = requestTrace.safeParse(raw);
      trace = r.success ? r.data : null;
      parsed.set(raw, trace);
    }
    return trace;
  };
  const traces = async (): Promise<RequestTrace[]> =>
    (await reader.traces()).map(parse).filter((t): t is RequestTrace => t !== null);
  const heads = async (): Promise<TraceHead[]> => (await traces()).map(headOf);

  const source: ConsoleDataSource = {
    describe: () => description,
    async artifacts(): Promise<SourceArtifacts> {
      const read = await options.artifacts();
      let model: SourceArtifacts['model'] = null;
      if (read.modelJson !== undefined) {
        const r = emittedModel.safeParse(read.modelJson);
        if (!r.success) throw new LocalArtifactError(`${options.label}: model.json is not a model: ${r.error.message}`);
        model = r.data;
      }
      return { model, permissions: read.permissionsMd === undefined ? null : parsePermissions(read.permissionsMd) };
    },
    queryRequests: async (query: RequestQuery) => pageOf(await heads(), query),
    facets: async (query: RequestQuery) => facetsOf(await heads(), query),
    async getTrace(invocationId: string) {
      // The buffer may hold an id twice (a re-recorded request); the last record is the complete one.
      const trace = (await traces()).findLast((t) => t.invocationId === invocationId);
      if (!trace) return null;
      // Steps leave the source only here, so this is where bound values are withheld.
      return rawPayloads ? trace : withoutRawPayloads(trace);
    },
  };
  const subscribe = reader.subscribe?.bind(reader);
  if (subscribe) {
    source.tail = (query, listener) =>
      subscribe((raw) => {
        const trace = parse(raw);
        if (trace && matchesWhere(trace, query.where)) listener(headOf(trace));
      });
  }
  return source;
}
