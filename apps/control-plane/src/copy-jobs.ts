import type { CopyJobDo } from '@substrat-run/adapter-cloudflare';
import { newCopyJob, type CopyJobRecord, type CopyJobs, type StoreMoveJobRecord, type StoreMoveJobs } from '@substrat-run/control-plane-api';

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
    markNewest: (key, order, holdMs) => stubOf(key).markNewest(order, holdMs),
  };
}

/**
 * A backup's or a restore's store move past one request (D-69, #2854), over the same class: one object
 * per job id, which `storeMoveJobId` keeps apart from a preview copy's (`copyJobId`).
 */
export function durableStoreMoveJobs(ns: DurableObjectNamespace): StoreMoveJobs {
  const stubOf = (id: string) => ns.get(ns.idFromName(id)) as unknown as CopyJobDo<StoreMoveJobRecord>;
  return {
    start: (record) => stubOf(record.spec.id).start(record),
    get: (id) => stubOf(id).get(),
    claim: (id, holdMs) => stubOf(id).claim(holdMs),
    forget: (id) => stubOf(id).forget(),
  };
}
