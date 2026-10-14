/**
 * The headless client, reduced to what the size measurement needs: it opens an SSE stream,
 * folds events into view state, remembers the last id so a dropped connection resumes
 * exactly after it, and exposes send / approve / stop.
 */
export function connect(endpoint, thread, onState) {
  let lastId = 0;
  let controller = null;
  const state = { messages: [], phase: 'idle', approval: null };
  const push = () => onState({ ...state, messages: state.messages.map((m) => ({ ...m })) });

  function fold(e) {
    lastId = Math.max(lastId, e.id ?? 0);
    const ai = () => {
      let m = state.messages[state.messages.length - 1];
      if (!m || m.role !== 'ai') state.messages.push((m = { role: 'ai', text: '', steps: [] }));
      return m;
    };
    if (e.t === 'user-message') state.messages.push({ role: 'user', text: e.text });
    if (e.t === 'turn-start') state.phase = 'streaming';
    if (e.t === 'text-delta') ai().text += e.delta;
    if (e.t === 'tool-input') ai().steps.push(`Running ${e.tool}`);
    if (e.t === 'approval-request') state.approval = e;
    if (e.t === 'approval-resolved') state.approval = null;
    if (e.t === 'turn-finish') state.phase = 'idle';
  }

  async function stream(url, init) {
    controller = new AbortController();
    for (;;) {
      try {
        const res = await fetch(url + (lastId ? `${url.includes('?') ? '&' : '?'}after=${lastId}` : ''), {
          ...init,
          headers: { ...(init?.headers ?? {}), ...(lastId ? { 'last-event-id': String(lastId) } : {}) },
          signal: controller.signal,
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
            buf = buf.slice(i + 2);
            if (data) fold(JSON.parse(data.slice(6)));
          }
          push();
        }
        return;
      } catch (err) {
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 500)); // resume exactly after lastId
        init = { method: 'GET' };
        url = `${endpoint}/${thread}/events`;
      }
    }
  }

  return {
    send: (text) => stream(`${endpoint}/${thread}/message`, { method: 'POST', body: JSON.stringify({ text }) }),
    approve: (req, approved) =>
      stream(`${endpoint}/${thread}/approve`, {
        method: 'POST',
        body: JSON.stringify({ callId: req.callId, digest: req.digest, approved }),
      }),
    stop: () => controller?.abort(),
  };
}
