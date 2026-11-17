/**
 * One request's answer, as a view may claim it (#3244). A list defaulting to `[]` cannot tell
 * "nothing there" from "not here yet" or from "the read failed", and a view handed only the
 * array draws its empty state for all three — a false claim about the data. This union keeps
 * the three apart: `ok` exists only once a response has settled, and an error is never an
 * empty value.
 */
export type RequestState<T> = { state: 'loading' } | { state: 'error'; error: unknown } | { state: 'ok'; value: T };

const LOADING: RequestState<never> = { state: 'loading' };

export const requestLoading = <T>(): RequestState<T> => LOADING;
export const requestOk = <T>(value: T): RequestState<T> => ({ state: 'ok', value });
export const requestFailed = <T>(error: unknown): RequestState<T> => ({ state: 'error', error });

/**
 * A read that failed, against what is already shown. A refresh that fails while an answer is
 * on screen keeps that answer — flipping a page of data to an error banner over a missed poll
 * would read as the data vanishing; a read that never answered becomes the error.
 */
export const settleFailure =
  <T>(error: unknown) =>
  (prev: RequestState<T>): RequestState<T> =>
    prev.state === 'ok' ? prev : requestFailed(error);

/** The value, or `fallback` while there is none — for the reads (lookups, counts) that need no state. */
export const valueOr = <T>(s: RequestState<T>, fallback: T): T => (s.state === 'ok' ? s.value : fallback);

/** Change an answer in place (an optimistic edit); a state with no answer is left as it is. */
export const mapOk =
  <T>(fn: (value: T) => T) =>
  (s: RequestState<T>): RequestState<T> =>
    s.state === 'ok' ? requestOk(fn(s.value)) : s;

/** What to show a person for a failed read: the server's own words when it gave some. */
export function requestErrorText(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return null;
}
