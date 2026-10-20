import type { CopyJobDo } from '@substrat-run/adapter-cloudflare';
import { newCopyJob, type CopyJobRecord, type CopyJobs } from '@substrat-run/control-plane-api';

/**
 * The preview route's job store over `ScopeCopyJobDO` (#2450): one object per job id. Its own module
 * so a test drives the production wiring rather than a copy of it.
 */
export function durableCopyJobs(ns: DurableObjectNamespace): CopyJobs {
  const stubOf = (id: string) => ns.get(ns.idFromName(id)) as unknown as CopyJobDo<CopyJobRecord>;
  return {
    start: (spec, state) => stubOf(spec.id).start(newCopyJob(spec, state)),
    get: (id) => stubOf(id).get(),
    claim: (id, holdMs) => stubOf(id).claim(holdMs),
    cancel: (id) => stubOf(id).cancel(),
    forget: (id) => stubOf(id).forget(),
  };
}
