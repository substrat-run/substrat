/**
 * The per-request log line and the platform's entry wrapper (#1978).
 *
 * Moving here from the kernel: this is host-side HTTP code that every deployed vertical
 * mounts, and nothing in it needs a kernel guarantee. For one release the definition still
 * lives in `@substrat-run/kernel` and this module re-exports that same binding, so an
 * import from either package is the one function. Import it from here.
 */
export {
  invocationLog,
  INVOCATION_RECORD_KEY,
  invocationStampOf,
  withInvocationLog,
} from '@substrat-run/kernel';
export type {
  InvocationLogLine,
  InvocationLogContext,
  InvocationRecord,
  OutputFieldsReport,
  InvocationStamp,
  ModuleWorker,
  IncomingRequest,
} from '@substrat-run/kernel';
