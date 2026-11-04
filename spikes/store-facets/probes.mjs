// The probe sequence, shared by the local run (run-local.mjs) and the run against a real dispatch
// namespace (probe.mjs). `request(path, params, body)` POSTs and returns the parsed JSON answer of the supervisor.
// Each check names the D-70 question it answers. A check that fails is a finding, not a bug in the
// spike: the result block is what gets pasted back.

const run = () => Math.random().toString(36).slice(2, 10);

export async function runProbes(request, { graph = false, drivers = ['js', 'py'], log = console.log } = {}) {
  const tag = run();
  const object = (name) => `spike/${tag}/${name}`;
  const call = (name, params, body) => request('/call', { object: object(name), ...params }, body);
  const checks = [];
  const timings = {};
  const check = (question, name, pass, detail) => {
    checks.push({ question, name, pass: Boolean(pass), detail });
    log(`${pass ? 'PASS' : 'FAIL'}  [${question}] ${name}${pass ? '' : `  ${JSON.stringify(detail)}`}`);
  };

  const info = await request('/info', {});
  check('loader', 'the script has a Worker Loader binding', info.loader === true, info);

  for (const driver of drivers) {
    // Isolates: an id per object gives each object its own; one id shared by objects gives one.
    const a1 = await call(`${driver}-a`, { driver, op: 'mark' });
    const a2 = await call(`${driver}-a`, { driver, op: 'mark' });
    const b = await call(`${driver}-b`, { driver, op: 'mark' });
    check('isolate', `${driver}: one object's calls reach the same isolate`, a1.answer?.mark && a1.answer.mark === a2.answer?.mark, { a1, a2 });
    check('isolate', `${driver}: two objects with their own ids reach two isolates`, a1.answer?.mark && b.answer?.mark && a1.answer.mark !== b.answer.mark, { a1, b });
    const sa = await call(`${driver}-sa`, { driver, op: 'mark', share: '1' });
    const sb = await call(`${driver}-sb`, { driver, op: 'mark', share: '1' });
    check('isolate', `${driver}: two objects sharing one id reach one isolate (the control)`, sa.answer?.mark && sa.answer.mark === sb.answer?.mark, { sa, sb });

    // Network: closed by globalOutbound null, and the control shows the probe would see it open.
    const closed = await call(`${driver}-net`, { driver, op: 'network' });
    check('network', `${driver}: fetch() throws with the network closed`, closed.answer?.fetch?.ok === false, closed);
    check('network', `${driver}: connect() throws with the network closed`, closed.answer?.connect?.ok === false, closed);
    const open = await call(`${driver}-open`, { driver, op: 'network', net: 'open' });
    check('network', `${driver}: the control, with the network inherited, reaches it`, open.answer?.fetch?.ok === true, open);

    // Env: the loaded isolate holds only what the supervisor passed, which is nothing.
    const env = await call(`${driver}-env`, { driver, op: 'env' });
    check('env', `${driver}: the driver's env is empty`, Array.isArray(env.answer?.env) && env.answer.env.length === 0, env);
    // ctx.exports, where present, names the loaded worker's own exports, never the supervisor's.
    if (driver === 'js') check('env', "js: the driver's ctx.exports names nothing of the supervisor's", !(env.answer?.exports ?? []).includes('Supervisor'), env);

    // Storage: the facet's own, apart from the supervisor's, and kept across an abort and new code.
    const store = `${driver}-store`;
    const wrote = await call(store, { driver, op: 'write', version: 'v1' });
    const read = await call(store, { driver, op: 'read', version: 'v1' });
    check('storage', `${driver}: the facet sees its own table and not the supervisor's`, wrote.answer?.rows === 1 && read.answer?.tables?.includes('facet_rows') && !read.answer.tables.includes('supervisor_only'), { wrote, read });
    const sup = await request('/supervisor-tables', { object: object(store) });
    check('storage', `${driver}: the supervisor sees its own table and not the facet's`, sup.tables?.includes('supervisor_only') && !sup.tables.includes('facet_rows'), sup);
    await request('/restart', { object: object(store) });
    const after = await call(store, { driver, op: 'read', version: 'v2' });
    check('restart', `${driver}: after an abort, new code runs over the same storage`, after.answer?.version === 'v2' && after.answer?.rows === 1, after);
  }

  // Cold start: the first call to a fresh object loads its isolate; the second is warm.
  const cold = async (driver, name) => {
    // The graph driver is called as the store entry calls it: the reserved selfcheck builds its runtime.
    const body = driver === 'graph' ? JSON.stringify({ operation: 'substrat.selfcheck', objectName: object(name), input: {} }) : undefined;
    const first = await call(name, { driver, op: driver === 'graph' ? 'invoke' : 'mark', heap: '1' }, body);
    const second = await call(name, { driver, op: driver === 'graph' ? 'invoke' : 'mark', heap: '1' }, body);
    timings[driver] = { firstMs: first.ms, warmMs: second.ms, heapBytes: second.heap?.heap ?? null, status: [first.status, second.status] };
    check('cold-start', `${driver}: measured (first ${first.ms} ms, warm ${second.ms} ms, heap ${second.heap?.heap ?? 'n/a'})`, first.status === 200 && second.status === 200, { first, second });
  };
  if (drivers.includes('py')) await cold('py', 'py-cold');
  if (graph) {
    check('graph', 'the graph release is packed into the script', info.graph?.files > 0, info.graph);
    await cold('graph', 'graph-cold');
  }

  const failed = checks.filter((c) => !c.pass).length;
  return { tag, info, checks, timings, failed };
}
