/** Local, bounded request traces for `substrat dev` (#2358). */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  requestTrace,
  TRACE_STEP_CAP,
  type RequestTrace,
  type TraceHead,
  type TraceHeadPatch,
  type TraceSink,
  type TraceStep,
} from '@substrat-run/contracts';

const TRACE_MAX_REQUESTS = 256;
const TRACE_MAX_BYTES = 8 * 1024 * 1024;

/** A file per completed request lets watch restarts write concurrently without a shared index. */
export class LocalTraceStore {
  constructor(
    readonly dir: string,
    private readonly maxRequests = TRACE_MAX_REQUESTS,
    private readonly maxBytes = TRACE_MAX_BYTES,
  ) {}

  write(trace: RequestTrace): void {
    mkdirSync(this.dir, { recursive: true });
    const name = `${Date.now().toString().padStart(13, '0')}-${process.hrtime.bigint().toString().padStart(20, '0')}-${process.pid}-${randomUUID()}.json`;
    const target = join(this.dir, name);
    const temporary = join(this.dir, `.${name}.tmp`);
    let data = JSON.stringify(trace);
    if (Buffer.byteLength(data) > this.maxBytes) {
      // One verbose request still gets a record. Its head survives and the omitted steps
      // are explicit, so the buffer never grows past its byte budget for one request.
      data = JSON.stringify({
        ...trace,
        steps: [],
        capture: { ...trace.capture, stepsDropped: trace.capture.stepsDropped + trace.steps.length },
      });
    }
    if (Buffer.byteLength(data) > this.maxBytes) return;
    try {
      writeFileSync(temporary, data);
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.prune();
  }

  /** Newest first; malformed/incomplete files cannot break a trace read. */
  traces(): RequestTrace[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort().reverse();
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const traces: RequestTrace[] = [];
    for (const name of names) {
      try {
        const parsed = requestTrace.safeParse(JSON.parse(readFileSync(join(this.dir, name), 'utf8')));
        if (parsed.success) traces.push(parsed.data);
      } catch (error) {
        if (!missing(error) && !(error instanceof SyntaxError)) throw error;
      }
    }
    return traces;
  }

  private prune(): void {
    // Each writer publishes before listing. Of two concurrent writers, the one that publishes
    // last sees both files and restores the bound; a concurrent unlink is harmless.
    const files = readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort();
    let bytes = 0;
    const sizes = files.map((name) => {
      try {
        const size = statSync(join(this.dir, name)).size;
        bytes += size;
        return size;
      } catch (error) {
        if (missing(error)) return 0;
        throw error;
      }
    });
    let count = files.length;
    for (let i = 0; (count > this.maxRequests || bytes > this.maxBytes) && i < files.length; i++) {
      try {
        rmSync(join(this.dir, files[i]!));
      } catch (error) {
        if (!missing(error)) throw error;
      }
      count--;
      bytes -= sizes[i]!;
    }
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

interface Pending {
  head: Partial<TraceHead>;
  steps: TraceStep[];
  stepsDropped: number;
}

/** The existing host hooks send patches and steps; only this dev process assembles them. */
export function createDevTraceSink(store: LocalTraceStore, line: (trace: RequestTrace) => void): TraceSink {
  const pending = new Map<string, Pending>();
  const forId = (id: string): Pending => {
    let record = pending.get(id);
    if (!record) {
      record = { head: { invocationId: id }, steps: [], stepsDropped: 0 };
      pending.set(id, record);
    }
    return record;
  };
  return {
    capture: { sqlParams: false },
    head(id: string, patch: TraceHeadPatch) {
      const record = forId(id);
      const { stepsDropped = 0, ...head } = patch;
      record.stepsDropped += stepsDropped;
      for (const [key, value] of Object.entries(head)) {
        if (value !== undefined) (record.head as Record<string, unknown>)[key] = value;
      }
    },
    step(id: string, step: TraceStep) {
      const record = forId(id);
      if (record.steps.length >= TRACE_STEP_CAP) {
        record.stepsDropped++;
        return;
      }
      // Never persist bound SQL values even if a caller ignored `capture.sqlParams`.
      if (step.type === 'sql') {
        const { params: _params, ...withoutParams } = step;
        record.steps.push(withoutParams);
      } else {
        record.steps.push(step);
      }
    },
    end(id: string) {
      const record = pending.get(id);
      pending.delete(id);
      if (!record) return;
      const trace = requestTrace.parse({
        invocationId: id,
        startedAt: new Date().toISOString(),
        tenantId: '',
        scopeId: null,
        vertical: null,
        surface: null,
        method: null,
        path: null,
        status: null,
        threw: false,
        durationMs: 0,
        level: 'info',
        operation: null,
        problemCode: null,
        principalKind: null,
        principal: null,
        eventCount: null,
        eventTypes: [],
        entities: [],
        versionId: null,
        specVersion: null,
        ...record.head,
        steps: record.steps,
        capture: { sqlParams: false, stepsDropped: record.stepsDropped },
      });
      store.write(trace);
      line(trace);
    },
  };
}

export function traceLine(trace: RequestTrace): string {
  const principal = typeof trace.principal === 'string'
    ? trace.principal
    : trace.principal ? Object.values(trace.principal).join(':') : trace.principalKind ?? '-';
  const check = [...trace.steps].reverse().find((step) => step.type === 'check');
  const rule = check?.type === 'check'
    ? check.allowed
      ? `allowed by ${check.decidedBy ?? '-'}`
      : `requires ${check.requires.join(',') || '-'}; caller has ${check.callerHas.join(',') || '-'}`
    : '-';
  return `[substrat trace] ${trace.invocationId} ${trace.operation ?? '-'} ${principal} ${trace.status ?? '-'} ${trace.durationMs}ms ${trace.problemCode ?? '-'} ${rule}`;
}
