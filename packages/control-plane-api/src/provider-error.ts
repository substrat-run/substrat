/**
 * Classifying a failed connector delivery: retry it, or quote it as the provider's (#1978).
 *
 * Moving here from the kernel: only the control plane's drain reads it. For one release the
 * definition still lives in `@substrat-run/kernel` and this module re-exports that same
 * binding, so an import from either package is the one function. Import it from here.
 */
export {
  isTerminalDispatchFailure,
  isTerminalProviderError,
  providerErrorStatus,
  RETRYABLE_CLIENT_STATUSES,
} from '@substrat-run/kernel';
