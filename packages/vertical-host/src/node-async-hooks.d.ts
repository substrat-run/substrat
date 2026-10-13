/** The one node builtin the invocation log uses. Workerd provides it under `nodejs_als`. */
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
