/** Installed only by `substrat dev` in the project's local process tree. */
import { join } from 'node:path';
import { TRACE_SINK_KEY } from '@substrat-run/contracts/trace-sink';
import { createDevTraceSink, LocalTraceStore, traceLine } from './dev-traces.js';

function warn(error: unknown): void {
  if (process.env.SUBSTRAT_DEV_TRACE_WARNED) return;
  process.env.SUBSTRAT_DEV_TRACE_WARNED = '1';
  process.stderr.write(`warning: local request traces unavailable: ${String(error)}\n`);
}

const project = process.env.SUBSTRAT_DEV_TRACE_DIR;
if (project) {
  try {
    const store = new LocalTraceStore(join(project, '.data', 'substrat-traces'));
    const sink = createDevTraceSink(store, (trace) => process.stderr.write(`${traceLine(trace)}\n`));
    (globalThis as Record<symbol, unknown>)[TRACE_SINK_KEY] = {
      ...sink,
      end(id: string) {
        try {
          sink.end(id);
        } catch (error) {
          warn(error);
        }
      },
    };
  } catch (error) {
    warn(error);
  }
}
