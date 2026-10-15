/**
 * Test clients. Each records when every event arrived, so latency and lag are measured
 * from the client's side, which is the side a user sits on.
 */

const now = () => performance.now();

export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** An SSE client over a miniflare worker. `onEvent` may call `abort()` to disconnect. */
export function sseClient(worker, path, { method = 'GET', body, headers = {}, onEvent } = {}) {
  const controller = new AbortController();
  const t0 = now();
  const events = [];
  const result = { events, status: 0, t0, aborted: false, error: null };
  result.abort = () => {
    result.aborted = true;
    controller.abort();
  };
  result.done = (async () => {
    let res;
    try {
      res = await worker.fetch(`http://spike${path}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      result.error = err;
      return result;
    }
    result.status = res.status;
    if (!res.ok) {
      result.body = await res.json().catch(() => null);
      return result;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6));
          const entry = { event, at: now() - t0 };
          events.push(entry);
          onEvent?.(entry, result);
          // A disconnect means nothing after it was seen. Without this, frames already
          // buffered in the same chunk were still recorded, and under load one chunk can hold
          // the rest of the phase, which left S2 nothing to resume.
          if (result.aborted) return result;
        }
      }
    } catch (err) {
      if (!result.aborted) result.error = err;
    }
    return result;
  })();
  return result;
}

/** A WebSocket client over a miniflare worker. */
export async function wsClient(worker, path, { onEvent } = {}) {
  const t0 = now();
  const res = await worker.fetch(`http://spike${path}`, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket (status ${res.status})`);
  ws.accept();
  const events = [];
  const waiters = [];
  const client = { events, t0, closed: false, ws };
  ws.addEventListener('message', (m) => {
    const event = JSON.parse(typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data));
    const entry = { event, at: now() - t0 };
    events.push(entry);
    onEvent?.(entry, client);
    for (const w of [...waiters]) if (w.pred(entry)) w.resolve(entry);
  });
  ws.addEventListener('close', () => {
    client.closed = true;
    for (const w of waiters) w.resolve(null);
  });
  client.send = (msg) => ws.send(JSON.stringify(msg));
  client.close = () => {
    try {
      ws.close(1000, 'bye');
    } catch {}
  };
  client.waitFor = (pred, ms = 8000) =>
    new Promise((resolve, reject) => {
      const hit = events.find((e) => pred(e));
      if (hit) return resolve(hit);
      const w = { pred, resolve: (v) => { clearTimeout(timer); waiters.splice(waiters.indexOf(w), 1); resolve(v); } };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error('timed out waiting for event'));
      }, ms);
      waiters.push(w);
    });
  client.lastId = () => events.reduce((m, e) => Math.max(m, e.event.id ?? 0), 0);
  return client;
}

/** Fold events into the text the user would see, honouring step-restart. */
export function render(events) {
  const parts = [];
  let stepFrom = 0;
  for (const e of events) {
    if (e.t === 'step-start') stepFrom = parts.length;
    if (e.t === 'step-restart') parts.length = stepFrom;
    if (e.t === 'text-start') parts.push({ pid: e.pid, text: '' });
    if (e.t === 'text-delta') {
      const p = [...parts].reverse().find((x) => x.pid === e.pid);
      if (p) p.text += e.delta;
    }
  }
  return parts.map((p) => p.text.trim()).join(' | ');
}
