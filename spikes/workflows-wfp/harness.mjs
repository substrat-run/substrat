// What both runs share: the report lines, the client over the vertical's routes, and the waits.
// run-local.mjs hands it a miniflare worker's fetch; probe.mjs hands it the deployed dispatcher.

export function reporter() {
  let failures = 0;
  const seen = {};
  const lines = [];
  const out = (line) => {
    lines.push(line);
    console.log(line);
  };
  return {
    pass: (label) => out(`PASS  ${label}`),
    fail: (label, detail) => {
      failures++;
      out(`FAIL  ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
    },
    check(cond, label, detail) {
      return cond ? this.pass(label) : this.fail(label, detail);
    },
    see: (key, label, value) => {
      seen[key] = value;
      out(`SEEN  [${key}] ${label}: ${JSON.stringify(value)}`);
    },
    heading: (text) => out(`\n# ${text}`),
    failures: () => failures,
    seen,
    lines,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A client for one vertical script. `send(path, query)` returns the Response; every call is counted,
 * since every one goes through the entry and the gate count is judged against it.
 */
export function makeClient(send) {
  let calls = 0;
  const get = async (path, q = {}) => {
    calls++;
    const res = await send(path, q);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: `non-JSON ${res.status}: ${text.slice(0, 200)}` };
    }
  };
  return {
    get,
    calls: () => calls,
    start: (scope, orderId, params = {}) => get('/start', { scope, orderId, params: JSON.stringify({ scope, orderId, ...params }) }),
    status: (id) => get('/status', { id }),
    approve: (scope, orderId, ring = true) => get('/approve', { scope, orderId, ring: ring ? '1' : '0' }),
    bell: (id, n = '') => get('/bell', { id, n }),
    dump: (scope) => get('/dump', { scope }),
    terminate: (id) => get('/terminate', { id }),
  };
}

/** Polls `fn` until it answers `{ ok: true }`; `timing` differs between local and hosted runs. */
export function waits(timing = { timeoutMs: 15_000, pollMs: 100, settleMs: 300 }) {
  const until = async (label, fn, timeoutMs = timing.timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await fn();
      if (last.ok) return last.value;
      await sleep(timing.pollMs);
    }
    throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last?.value)}`);
  };
  return {
    timing,
    until,
    statusIs: (c, id, ...wanted) =>
      until(`${id} to reach ${wanted.join('|')}`, async () => {
        const s = await c.status(id);
        return { ok: wanted.includes(s.status), value: s };
      }),
    /**
     * Locally an instance in waitForEvent reports `running`, not `waiting`, so "parked at its wait"
     * is read from the scope: the step just before the wait has written its effect row. The pause
     * after it lets the engine reach the wait itself.
     */
    parked: async (c, scope, ref, extraMs = timing.settleMs) => {
      await until(`${ref} to reach its wait`, async () => {
        const d = await c.dump(scope);
        return { ok: (d.effects ?? []).some((e) => e.ref === ref), value: d };
      });
      await sleep(extraMs);
    },
  };
}

export const factsFor = (dump, ref) => (dump.facts ?? []).filter((f) => f.ref === ref);
