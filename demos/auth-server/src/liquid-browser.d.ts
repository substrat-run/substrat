/**
 * liquidjs ships no exports map, and its `main` is the node build, which imports `fs`, `path`,
 * `stream` and `crypto`. `page-template.ts` imports the browser build by path so every runtime
 * (workerd, node, the tests) runs the same file with no node builtin in it; its types are the
 * package's own.
 */
declare module 'liquidjs/dist/liquid.browser.mjs' {
  export * from 'liquidjs';
}
