import { readFileSync } from 'node:fs';
import { scopeStoreObjectName, type ScopeDumpTable } from '@substrat-run/contracts';
import { platformScopeStoresFor, type PlatformScopeStores } from '../../src/platform-scope-stores.js';

const vector = JSON.parse(
  readFileSync(new URL('../../../contracts/test/vectors/scope-store-envelope.json', import.meta.url), 'utf8'),
) as { privateKeyPkcs8: string };

/**
 * How many rows the control plane has been handed and not yet passed on, and the most it ever held:
 * a store's page answer adds, a stage or a page object written takes away.
 */
export interface HeldRows {
  now: number;
  peak: number;
}

type Stage = { id: string; pages: ScopeDumpTable[][] };
type StoreObject = {
  tables: ScopeDumpTable[];
  revision: number;
  stage?: Stage;
  committed?: { id: string; count: number };
  /** Set by `substrat.fence`, as the store entry keeps it (D-70). */
  fenced?: boolean;
};

const mergeTables = (pages: readonly ScopeDumpTable[][]): ScopeDumpTable[] => {
  const merged = new Map<string, ScopeDumpTable>();
  for (const table of pages.flat()) {
    const held = merged.get(table.name);
    if (held) held.rows.push(...table.rows);
    else merged.set(table.name, { ...table, rows: [...table.rows] });
  }
  return [...merged.values()];
};

const storeError = (status: number, code: string) => Response.json({ error: { code, status } });

export interface StoreCallSeen {
  operation: string;
  objectName: string;
  input: unknown;
  /** How many times this operation with this input has been asked, this one included. */
  nth: number;
}

/**
 * A store driver behind the real dispatch, keeping the D-69 contract: chains of pages under one
 * revision, stages held aside, a commit that replaces, a commit asked again answering the same count.
 * `pageRows` is how many rows it cuts a page at, as a driver may cut smaller than it is asked.
 */
export function fakeStoreDriver(opts: { pageRows?: number } = {}) {
  const pageRows = opts.pageRows ?? 10;
  const objects = new Map<string, StoreObject>();
  const held: HeldRows = { now: 0, peak: 0 };
  const calls: StoreCallSeen[] = [];
  /** Run before a call is answered. A `Response` answers it; `'lost'` applies the call and loses the answer. */
  let intercept: ((call: StoreCallSeen) => Response | 'lost' | undefined) | undefined;
  /** Run before a call is seen, and waited for: another writer landing in the middle of a move. */
  let before: ((call: StoreCallSeen) => Promise<void>) | undefined;
  const asked = new Map<string, number>();

  const objectOf = (name: string): StoreObject => {
    let object = objects.get(name);
    if (!object) {
      object = { tables: [], revision: 1 };
      objects.set(name, object);
    }
    return object;
  };

  const exportPage = (object: StoreObject, cursor: string | null): Response => {
    const start = cursor === null ? 0 : Number(cursor);
    const page: ScopeDumpTable[] = [];
    let at = 0;
    let taken = 0;
    for (const table of object.tables) {
      const from = Math.max(0, start - at);
      const rows = table.rows.slice(from, from + (pageRows - taken));
      // Every table's heading travels on the first page, so an empty one's schema does too.
      if (rows.length > 0 || start === 0) page.push({ ...table, rows });
      taken += rows.length;
      at += table.rows.length;
    }
    held.now += taken;
    held.peak = Math.max(held.peak, held.now);
    return Response.json({ result: { tables: page, next: start + taken < at ? String(start + taken) : null, revision: `r${object.revision}` } });
  };

  const apply = (object: StoreObject, operation: string, input: Record<string, unknown>): Response => {
    // The store entry's half (D-70): a fenced object refuses what would write, and a fence is its wipe.
    if (object.fenced && (operation === 'substrat.stage-page' || operation === 'substrat.commit-stage')) return storeError(410, 'store_fenced');
    if (operation === 'substrat.fence') object.fenced = true;
    switch (operation) {
      case 'substrat.size':
        return Response.json({ result: { bytes: JSON.stringify(object.tables).length } });
      case 'substrat.export-page':
        return exportPage(object, input.cursor as string | null);
      case 'substrat.stage-page': {
        const { stageId, seq, tables } = input as { stageId: string; seq: number; tables: ScopeDumpTable[] };
        if (object.committed?.id === stageId) return storeError(409, 'stage_refused');
        if (seq === 0 && object.stage?.id !== stageId) object.stage = { id: stageId, pages: [] };
        if (object.stage?.id !== stageId) return storeError(409, 'stage_refused');
        if (seq < object.stage.pages.length) return Response.json({ result: { staged: false } });
        if (seq > object.stage.pages.length) return storeError(409, 'stage_refused');
        object.stage.pages.push(tables);
        held.now -= tables.reduce((n, t) => n + t.rows.length, 0);
        return Response.json({ result: { staged: true } });
      }
      case 'substrat.commit-stage': {
        const { stageId } = input as { stageId: string };
        if (object.committed?.id === stageId) return Response.json({ result: { tables: object.committed.count } });
        if (object.stage?.id !== stageId) return storeError(409, 'stage_refused');
        object.tables = mergeTables(object.stage.pages);
        object.committed = { id: stageId, count: object.tables.length };
        object.stage = undefined;
        object.revision += 1;
        return Response.json({ result: { tables: object.committed.count } });
      }
      case 'substrat.discard-stage': {
        const { stageId } = input as { stageId: string };
        const discarded = object.stage?.id === stageId;
        if (discarded) object.stage = undefined;
        return Response.json({ result: { discarded } });
      }
      case 'substrat.fence':
      case 'substrat.wipe':
        object.tables = [];
        object.stage = undefined;
        object.committed = undefined;
        object.revision += 1;
        return Response.json({ result: {} });
      case 'substrat.erase': {
        const { subjectId } = input as { subjectId: string };
        let erased = 0;
        for (const table of object.tables) {
          const kept = table.rows.filter((row) => row[0] !== subjectId);
          erased += table.rows.length - kept.length;
          table.rows = kept;
        }
        object.stage = undefined;
        if (erased > 0) object.revision += 1;
        return Response.json({ result: { erased } });
      }
      default:
        return storeError(400, 'unknown_operation');
    }
  };

  const fetch = async (_script: string, request: Request): Promise<Response> => {
    const { operation, input, objectName } = JSON.parse(await request.text()) as {
      operation: string;
      input?: Record<string, unknown>;
      objectName: string;
    };
    const key = `${objectName} ${operation} ${JSON.stringify(input)}`;
    const nth = (asked.get(key) ?? 0) + 1;
    asked.set(key, nth);
    const call: StoreCallSeen = { operation, objectName, input, nth };
    calls.push(call);
    await before?.(call);
    const verdict = intercept?.(call);
    if (verdict instanceof Response) return verdict;
    const answer = apply(objectOf(objectName), operation, input ?? {});
    return verdict === 'lost' ? new Response('lost', { status: 503 }) : answer;
  };

  return {
    fetch,
    held,
    calls,
    objects,
    intercept(run: typeof intercept): void {
      intercept = run;
    },
    before(run: typeof before): void {
      before = run;
    },
    /** A table of `rows` rows in the named object, each row `[id, 'x']`, moving its revision. */
    put(name: string, rows: number, table = 'nodes'): void {
      const object = objectOf(name);
      const filled = Array.from({ length: rows }, (_, i) => [`n${i}`, 'x']);
      object.tables = [...object.tables.filter((t) => t.name !== table), { name: table, ddl: `graph ${table}`, columns: ['id', 'pad'], rows: filled }];
      object.revision += 1;
    },
    /** A write nothing else notices: the revision moves. */
    write(name: string): void {
      objectOf(name).revision += 1;
    },
    idsOf(name: string, table = 'nodes'): unknown[] {
      return (objectOf(name).tables.find((t) => t.name === table)?.rows ?? []).map((row) => row[0]);
    },
    rowsOf(name: string): number {
      return objectOf(name).tables.reduce((n, t) => n + t.rows.length, 0);
    },
    stageOf(name: string): Stage | undefined {
      return objectOf(name).stage;
    },
    callsOf(operation: string): number {
      return calls.filter((call) => call.operation === operation).length;
    },
  };
}
export type FakeStoreDriver = ReturnType<typeof fakeStoreDriver>;

export const storeObject = scopeStoreObjectName;

/** The real caller, signing and all, over a fake driver, with no real wait between retries. */
export function platformOver(
  driver: Pick<FakeStoreDriver, 'fetch'>,
  opts: { retryDelaysMs?: readonly number[]; deadlineMs?: number } = {},
): PlatformScopeStores {
  return platformScopeStoresFor({
    platformKey: vector.privateKeyPkcs8,
    fetch: driver.fetch,
    retryDelaysMs: opts.retryDelaysMs ?? [0, 0],
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
  });
}

/**
 * A bucket with R2's list and batch delete: pages of `pageSize`, in key order, a `delimiter` that
 * rolls up what lies below it, and metadata only when asked. `held`, when given, takes away the rows
 * of each store page written.
 */
export function fakeBucket(opts: { pageSize?: number; held?: HeldRows } = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const objects = new Map<string, { body: string; customMetadata?: Record<string, string> }>();
  let failPut: ((key: string) => boolean) | undefined;
  const bucket = {
    async put(key: string, value: string, options?: { customMetadata?: Record<string, string> }) {
      if (failPut?.(key)) throw new Error('bucket: put failed');
      objects.set(key, { body: value, ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}) });
      if (opts.held && key.includes('/stores/')) {
        const page = JSON.parse(value) as { tables: { rows: unknown[] }[] };
        opts.held.now -= page.tables.reduce((n, t) => n + t.rows.length, 0);
      }
    },
    async get(key: string) {
      const held = objects.get(key);
      return held ? { text: async () => held.body } : null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list(options: { prefix?: string; cursor?: string; include?: string[]; delimiter?: string } = {}) {
      const prefix = options.prefix ?? '';
      const under = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const visible = options.delimiter ? under.filter((key) => !key.slice(prefix.length).includes(options.delimiter!)) : under;
      const rolled = options.delimiter
        ? [...new Set(under.filter((key) => key.slice(prefix.length).includes(options.delimiter!))
          .map((key) => prefix + key.slice(prefix.length).split(options.delimiter!)[0] + options.delimiter!))]
        : [];
      const start = options.cursor ? Number(options.cursor) : 0;
      const next = start + pageSize;
      return {
        delimitedPrefixes: rolled,
        objects: visible.slice(start, next).map((key) => {
          const held = objects.get(key)!;
          return {
            key,
            size: new TextEncoder().encode(held.body).length,
            ...(options.include && held.customMetadata ? { customMetadata: held.customMetadata } : {}),
          };
        }),
        truncated: next < visible.length,
        ...(next < visible.length ? { cursor: String(next) } : {}),
      };
    },
  };
  return {
    bucket,
    objects,
    failPutWhen(run: typeof failPut): void {
      failPut = run;
    },
  };
}

/**
 * A caller made of whole-dump answers, for a suite about what is asked of a store and not how it
 * crosses: one page out of `exportTables`, and each commit handed to `imported`.
 */
export function pagedFromWhole(
  fake: {
    exportTables: (input: { scopeId: string; binding: string; driver: string }) => ScopeDumpTable[] | Promise<ScopeDumpTable[]>;
    imported?: (input: { scopeId: string; binding: string; tables: ScopeDumpTable[] }) => void | Promise<void>;
  } & Partial<Pick<PlatformScopeStores, 'eraseSubject' | 'fenceStores' | 'sizeStores'>>,
): PlatformScopeStores {
  const stages = new Map<string, ScopeDumpTable[][]>();
  return {
    callStore: ({ scopeId, binding, driver }) =>
      (async (operation: string, input?: { stageId?: string; tables?: ScopeDumpTable[] }) => {
        if (operation === 'substrat.export-page') {
          return { tables: await fake.exportTables({ scopeId, binding, driver }), next: null, revision: 'r1' };
        }
        if (operation === 'substrat.stage-page') {
          stages.set(input!.stageId!, [...(stages.get(input!.stageId!) ?? []), input!.tables!]);
          return { staged: true };
        }
        if (operation === 'substrat.commit-stage') {
          const tables = mergeTables(stages.get(input!.stageId!) ?? []);
          stages.delete(input!.stageId!);
          await fake.imported?.({ scopeId, binding, tables });
          return { tables: tables.length };
        }
        if (operation === 'substrat.discard-stage') return { discarded: stages.delete(input!.stageId!) };
        if (operation === 'substrat.size') return { bytes: 0 };
        throw new Error(`pagedFromWhole does not answer ${operation}`);
      }) as never,
    eraseSubject: fake.eraseSubject ?? (async ({ stores }) => stores.map((store) => ({ binding: store.binding, erased: 0 }))),
    fenceStores: fake.fenceStores ?? (async () => undefined),
    sizeStores: fake.sizeStores ?? (async () => []),
  };
}
