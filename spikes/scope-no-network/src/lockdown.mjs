// Option B of #861, at its strongest: a platform preamble that the entry imports FIRST, so it
// evaluates before any of the bundle's modules (ES module evaluation is depth-first in import
// order). It removes `fetch` and `WebSocket` from the global object and from every prototype on
// its chain, and leaves a refusing `fetch` in their place. D-61 refused this on principle; the
// spike asks the narrower factual question of what it leaves reachable.
const refused = () => {
  throw new Error('refused by the lockdown preamble');
};
for (let o = globalThis; o; o = Object.getPrototypeOf(o)) {
  for (const name of ['fetch', 'WebSocket']) {
    if (Object.getOwnPropertyDescriptor(o, name)) {
      try {
        delete o[name];
      } catch {
        // a non-configurable property stays; the probe will say so
      }
    }
  }
}
Object.defineProperty(globalThis, 'fetch', { value: refused, writable: false, configurable: false });
